#!/usr/bin/env node
/**
 * Jabee over MCP: let an agent ask a person before it acts.
 *
 * Four public projects exist only to put approvals on WhatsApp over MCP,
 * each one maintaining its own Twilio number and its own Meta template.
 * Jabee already has both, already handles the race between two people
 * tapping at once, and already expires a question nobody answers. This
 * is that, reachable the way an agent actually reaches a tool.
 *
 * Run it with one environment variable:
 *
 *   JABEE_API_KEY=jak_... npx @jabee/mcp
 *
 * The key is made on Management then Approvals at app.jabee.ai.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, JabeeError, type Approval } from "./client.js";
import { startedDirectly } from "./entry.js";

const VERSION = "0.1.3";

/**
 * How long `ask_person` waits before handing back a pending request.
 *
 * Two minutes, because an agent blocked on a tool call is an agent whose
 * client may time out, and because a decision nobody has made in two
 * minutes is usually one that needs longer than any tool call should
 * take. Past it the tool returns the id and the agent can poll.
 */
const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;

export function buildServer(deps: {
  apiKey: string;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}) {
  const client = createClient({
    apiKey: deps.apiKey,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  const server = new McpServer({ name: "jabee", version: VERSION });

  /** One shape for every answer, so an agent reads them all the same way. */
  function describe(a: Approval): string {
    const lines = [`id: ${a.id}`, `status: ${a.status}`];
    if (a.responded_by) lines.push(`answered by: ${a.responded_by.name}`);
    if (a.response_text) lines.push(`their words: ${a.response_text}`);
    if (a.status === "pending") {
      lines.push(`nobody has answered yet. It expires at ${a.expires_at}.`);
      lines.push(`Check again with check_approval and this id.`);
    }
    if (a.status === "expired") lines.push("nobody answered before it expired.");
    if (a.status === "failed") lines.push("it could not be delivered to anybody.");
    if (a.status === "cancelled") {
      lines.push(
        `it was withdrawn by the system that asked${a.cancel_reason ? `: ${a.cancel_reason}` : ""}. Do not act on it.`,
      );
    }
    if (a.outcome) lines.push(`outcome reported: ${a.outcome}${a.outcome_note ? ` (${a.outcome_note})` : ""}`);
    return lines.join("\n");
  }

  function fail(err: unknown) {
    const message =
      err instanceof JabeeError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }

  server.registerTool(
    "ask_person",
    {
      title: "Ask a person to approve something on WhatsApp",
      description:
        "Ask a named person to approve, reject or amend something, on WhatsApp, and wait " +
        "for their answer. Use this before doing anything that is expensive or impossible " +
        "to undo: issuing a refund, sending a quote, posting publicly, emailing a list, " +
        "deleting data. The person gets buttons on their phone and can also reply with " +
        "free text to amend what you proposed. Returns their decision, or the request id " +
        "if nobody has answered yet.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(120)
          .describe("The decision, in one line. 'Refund AED 450 to Sara'."),
        body: z
          .string()
          .max(2000)
          .optional()
          .describe("Why you are asking, and anything they need in order to decide."),
        url: z.string().url().optional().describe("A link to the thing being decided."),
        allow_amendment: z
          .boolean()
          .optional()
          .describe(
            "Offer an Edit button that asks for free text. Use it when the answer could " +
              "reasonably be 'yes but change this' rather than only yes or no.",
          ),
        external_id: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Your own id for the thing being decided. Sending the same one twice returns " +
              "the existing request rather than asking a second time, so a retry is safe.",
          ),
        expires_in_minutes: z
          .number()
          .int()
          .min(5)
          .max(10080)
          .optional()
          .describe("How long the decision stays useful. Defaults to a day."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe(
            "How long to wait for an answer before returning. Defaults to 120. Pass 0 to " +
              "return immediately and poll with check_approval.",
          ),
      },
    },
    async (args) => {
      try {
        const approval = await client.create({
          title: args.title,
          body: args.body,
          url: args.url,
          options: args.allow_amendment
            ? ["approve", "skip", "edit"]
            : ["approve", "skip"],
          external_id: args.external_id,
          expires_in_minutes: args.expires_in_minutes,
        });

        if (approval.status !== "pending") return { content: [{ type: "text", text: describe(approval) }] };

        const waitMs = Math.min(
          (args.wait_seconds ?? DEFAULT_WAIT_MS / 1000) * 1000,
          MAX_WAIT_MS,
        );
        if (waitMs === 0) return { content: [{ type: "text", text: describe(approval) }] };

        const settled = await client.waitFor(approval.id, waitMs);
        return { content: [{ type: "text", text: describe(settled) }] };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "check_approval",
    {
      title: "Check whether a request has been answered",
      description:
        "Read the current state of a request you asked earlier, by its id. Use this when " +
        "ask_person returned while still pending.",
      inputSchema: {
        id: z.string().describe("The id ask_person gave you."),
      },
    },
    async (args) => {
      try {
        return { content: [{ type: "text", text: describe(await client.get(args.id)) }] };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "tell_person",
    {
      title: "Tell a person something on WhatsApp",
      description:
        "Send a one-way notification to your own phone on WhatsApp: a build failed, an " +
        "order shipped, a job finished. This reaches your own verified people, never your " +
        "customers. Returns once it has been sent; it does not wait for a reply.",
      inputSchema: {
        title: z.string().min(1).max(120).describe("The headline, in one line."),
        body: z.string().max(2000).optional().describe("The detail."),
        url: z.string().url().optional().describe("A link to the thing."),
        external_id: z
          .string()
          .max(200)
          .optional()
          .describe("Your own id, so a retry does not send it twice."),
      },
    },
    async (args) => {
      try {
        const sent = await client.create({
          title: args.title,
          body: args.body,
          url: args.url,
          /**
           * One option rather than none: every request carries at least
           * one button, and a single Skip reads as "seen" and records who
           * saw it. Nothing waits on it.
           */
          options: ["skip"],
          external_id: args.external_id,
        });
        return {
          content: [
            {
              type: "text",
              text:
                sent.status === "failed"
                  ? "It could not be delivered. Check that a phone is verified for this account."
                  : `Sent. id: ${sent.id}`,
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

async function main() {
  const apiKey = process.env["JABEE_API_KEY"];
  if (!apiKey) {
    /**
     * stderr, not stdout. stdout is the MCP transport, and a friendly
     * sentence written there is a protocol error that surfaces to the
     * user as a server that will not start, with no reason given.
     */
    process.stderr.write(
      "JABEE_API_KEY is not set.\n\n" +
        "Make a key under Management then Approvals at https://app.jabee.ai/approvals,\n" +
        "then run this with JABEE_API_KEY=jak_... in the environment.\n",
    );
    process.exit(1);
  }

  const server = buildServer({
    apiKey,
    baseUrl: process.env["JABEE_BASE_URL"],
  });
  await server.connect(new StdioServerTransport());
}

/* Only when run, never when imported by a test. See entry.ts for why this
   is not a string comparison on the basename. */
if (startedDirectly(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`jabee-mcp failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
