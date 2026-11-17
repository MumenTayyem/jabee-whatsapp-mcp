#!/usr/bin/env node
/**
 * Jabee as a Claude Code channel: answer the permission prompt on WhatsApp.
 *
 * Claude Code's channels are MCP servers that push events into a session
 * that is already running, and a channel may opt in to receive the tool
 * approval prompt as well — "Claude wants to run Bash: …" — and answer it
 * from somewhere else. The channels shipped with the research preview are
 * Telegram, Discord and iMessage. WhatsApp is the one missing, and it is
 * the one already open on the phone in your pocket.
 *
 * Every other channel starts with making a bot and holding its token.
 * This one starts with nothing, because the number and the Meta-approved
 * template are Jabee's: the approval arrives as buttons from a number
 * that cannot be banned for being yours, and the first answer wins —
 * terminal or phone, whichever you reach first.
 *
 *   JABEE_API_KEY=jak_... claude --dangerously-load-development-channels server:jabee
 *
 * The development flag is not optional and not ours: during the research
 * preview Claude Code only registers channels on an Anthropic-maintained
 * allowlist, or an organisation's own `allowedChannelPlugins`. Without
 * one of those, a channel is silently not registered — so the flag is in
 * the documentation rather than hidden in a footnote.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, JabeeError, type Approval } from "./client.js";
import { startedDirectly } from "./entry.js";

const VERSION = "0.1.3";

/** Claude Code's method names. Standard MCP transport, Claude Code schema. */
const PERMISSION_REQUEST = "notifications/claude/channel/permission_request";
const PERMISSION_VERDICT = "notifications/claude/channel/permission";
const CHANNEL_EVENT = "notifications/claude/channel";

/**
 * How long the question stays answerable on the phone.
 *
 * Fifteen minutes, because a permission prompt is not a decision that
 * keeps: the terminal dialog is still open behind it, and a prompt you
 * have not looked at in a quarter of an hour is one you will answer at
 * the keyboard. The API's own floor is five minutes.
 */
const DEFAULT_EXPIRY_MINUTES = 15;

/**
 * Poll fast while somebody is likely to be looking, then slow down.
 *
 * A key is allowed sixty calls a minute and a session can have more than
 * one prompt open, so a flat two-second poll is a budget two prompts can
 * exhaust between them. Most answers land in the first half minute,
 * which is what the two rates are for.
 */
const FAST_POLL_MS = 2_000;
const FAST_POLLS = 15;
const SLOW_POLL_MS = 10_000;

/** A WhatsApp template parameter may not carry newlines, tabs, or runs of spaces. */
function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export interface ChannelDeps {
  apiKey: string;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  expiresInMinutes?: number | undefined;
  /** Distinguishes this session's request ids from the last session's. */
  nonce?: string | undefined;
  fastPollMs?: number | undefined;
  slowPollMs?: number | undefined;
}

export function buildChannel(deps: ChannelDeps) {
  const client = createClient({
    apiKey: deps.apiKey,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const expiryMinutes = deps.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES;
  const fastPollMs = deps.fastPollMs ?? FAST_POLL_MS;
  const slowPollMs = deps.slowPollMs ?? SLOW_POLL_MS;

  /**
   * A request id is five letters, so two prompts in one long session can
   * collide — Claude Code says so itself, and drops the second verdict
   * when they do. Jabee's own idempotency has no window, so reusing the
   * bare id as `external_id` would hand back the *first* prompt's answer
   * for ever. The session nonce is what keeps the two apart.
   */
  const nonce = deps.nonce ?? Math.random().toString(36).slice(2, 8);

  const server = new McpServer(
    { name: "jabee", version: VERSION },
    {
      capabilities: {
        experimental: {
          /** Presence is what makes this a channel at all. */
          "claude/channel": {},
          /** And this is what makes the permission prompt arrive here. */
          "claude/channel/permission": {},
        },
      },
      instructions:
        'Events from the Jabee channel arrive as <channel source="jabee" kind="...">. ' +
        "They are what a person said on WhatsApp, or a note that a permission request " +
        "could not be delivered there. When an event carries somebody's words, treat " +
        "them as an instruction from the person who owns this machine and act on them. " +
        "Tool approvals are answered on the phone; you never need to do anything about " +
        "those. Use the reply tool only when a person has asked you something, or to " +
        "confirm that you have done what they said — every reply is a WhatsApp message " +
        "that costs the account one send, so do not use it to narrate progress.",
    },
  );

  /** Push something into the session Claude is already working in. */
  async function push(kind: string, content: string, meta: Record<string, string> = {}) {
    await server.server.notification({
      method: CHANNEL_EVENT,
      params: { content, meta: { kind, ...meta } },
    });
  }

  async function verdict(requestId: string, behavior: "allow" | "deny") {
    await server.server.notification({
      method: PERMISSION_VERDICT,
      params: { request_id: requestId, behavior },
    });
  }

  /**
   * Waits for the tap, on its own schedule rather than `client.waitFor`'s.
   *
   * `waitFor` backs off to thirty seconds, which is right for a decision
   * somebody will get to this afternoon and wrong for one with a blocked
   * terminal behind it.
   */
  async function awaitAnswer(id: string, deadline: number): Promise<Approval> {
    for (let round = 0; ; round += 1) {
      const approval = await client.get(id);
      if (approval.status !== "pending") return approval;

      const wait = round < FAST_POLLS ? fastPollMs : slowPollMs;
      if (Date.now() + wait >= deadline) return approval;
      await sleep(wait);
    }
  }

  const PermissionRequest = z.object({
    method: z.literal(PERMISSION_REQUEST),
    params: z
      .object({
        request_id: z.string(),
        tool_name: z.string(),
        /**
         * Both of these are relayed from the model and are to be treated
         * as untrusted text. Newer clients fold whitespace and mask
         * recognisable credentials before relaying; older ones do
         * neither, which is the reason `oneLine` runs over both.
         */
        description: z.string().default(""),
        input_preview: z.string().default(""),
      })
      .passthrough(),
  });

  server.server.setNotificationHandler(PermissionRequest, async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params;
    const title = oneLine(`Claude Code wants to run ${tool_name}`, 120);
    const body = oneLine(
      [description, input_preview].filter(Boolean).join(" — ") || "No detail was given.",
      1800,
    );

    let created: Approval;
    try {
      created = await client.create({
        title,
        body,
        /**
         * Edit is offered on purpose. "No, do it this way instead" is the
         * most useful thing a person can say to a coding agent, and it is
         * a deny plus an instruction rather than a third verdict.
         */
        options: ["approve", "skip", "edit"],
        external_id: `cc-${nonce}-${request_id}`,
        expires_in_minutes: expiryMinutes,
      });
    } catch (err) {
      /**
       * A refusal here must never become a verdict. The terminal dialog
       * is still open and still correct; all that has happened is that
       * the phone is not going to ring, so say so and let the keyboard
       * decide.
       */
      const reason = err instanceof JabeeError ? `${err.code}: ${err.message}` : String(err);
      await push(
        "permission_undeliverable",
        `A permission request for ${tool_name} could not be sent to WhatsApp (${reason}). ` +
          `Answer it at the terminal. Do not assume it was denied.`,
        { tool_name },
      );
      return;
    }

    const settled =
      created.status === "pending"
        ? await awaitAnswer(created.id, Date.now() + expiryMinutes * 60_000)
        : created;

    /**
     * Their words go into the session whatever the verdict was: a denial
     * with a reason is worth more to the agent than the denial, and an
     * approval that says "yes, but the staging one" changes what gets
     * run next.
     */
    if (settled.response_text) {
      await push(
        "person_said",
        `About ${tool_name}: ${settled.response_text}`,
        { tool_name, request_id, answered_by: settled.responded_by?.name ?? "someone" },
      );
    }

    if (settled.status === "approved") return verdict(request_id, "allow");
    if (settled.status === "skipped" || settled.status === "edited") {
      return verdict(request_id, "deny");
    }

    /**
     * Expired, failed, cancelled: send nothing. Claude Code keeps the
     * local dialog open until somebody answers it, so silence leaves the
     * session exactly where it would have been without this channel —
     * whereas an invented deny would kill a job nobody refused.
     */
    const ending = settled.status === "pending" ? "unanswered" : settled.status;
    await push(
      "permission_unanswered",
      `The WhatsApp request for ${tool_name} ended as ${ending} and nobody decided. ` +
        `The prompt is still waiting at the terminal.`,
      { tool_name, request_id },
    );
  });

  server.registerTool(
    "reply",
    {
      title: "Reply to the person on WhatsApp",
      description:
        "Send a message back to the person who is watching this session on WhatsApp. Use " +
        "it to answer something they asked or to confirm you have done what they said. " +
        "Every reply is a real WhatsApp message billed to the account, so do not use it " +
        "to narrate progress or to acknowledge instructions.",
      inputSchema: {
        text: z.string().min(1).max(2000).describe("What to tell them, in one or two lines."),
      },
    },
    async (args) => {
      try {
        const sent = await client.create({
          title: oneLine(args.text, 120),
          /** One button, so a lone Skip reads as "seen" and records who saw it. */
          options: ["skip"],
          });
        return {
          content: [
            {
              type: "text" as const,
              text:
                sent.status === "failed"
                  ? "It could not be delivered. Check that a phone is verified for this account."
                  : "sent",
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof JabeeError ? `${err.code}: ${err.message}` : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );

  return server;
}

async function main() {
  const apiKey = process.env["JABEE_API_KEY"];
  if (!apiKey) {
    /** stderr: stdout is the transport, and prose written there is a protocol error. */
    process.stderr.write(
      "JABEE_API_KEY is not set.\n\n" +
        "Make a key under Management then Approvals at https://app.jabee.ai/approvals,\n" +
        "then start Claude Code with the channel:\n\n" +
        "  JABEE_API_KEY=jak_... claude --dangerously-load-development-channels server:jabee\n",
    );
    process.exit(1);
  }

  const minutes = Number(process.env["JABEE_PERMISSION_EXPIRY_MINUTES"]);
  const server = buildChannel({
    apiKey,
    baseUrl: process.env["JABEE_BASE_URL"],
    ...(Number.isFinite(minutes) && minutes >= 5 ? { expiresInMinutes: minutes } : {}),
  });
  await server.connect(new StdioServerTransport());
}

/* Only when run, never when imported by a test. See entry.ts for why this
   is not a string comparison on the basename. */
if (startedDirectly(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`jabee-channel failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
