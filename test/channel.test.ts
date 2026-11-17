import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChannel } from "../src/channel.js";

/**
 * The channel, driven the way Claude Code drives it: a client that sends
 * `notifications/claude/channel/permission_request` and listens for what
 * comes back. Calling the handler directly would prove nothing about the
 * part that breaks — whether the capabilities are declared, so the
 * prompt is ever sent here at all.
 */
const PERMISSION_REQUEST = "notifications/claude/channel/permission_request";
const PERMISSION_VERDICT = "notifications/claude/channel/permission";
const CHANNEL_EVENT = "notifications/claude/channel";

const approval = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  status: "pending",
  title: "Claude Code wants to run Bash",
  options: ["approve", "skip", "edit"],
  expires_at: "2026-11-13T10:15:00.000Z",
  created_at: "2026-11-13T10:00:00.000Z",
  updated_at: "2026-11-13T10:00:00.000Z",
  ...over,
});

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Seen {
  method: string;
  params: Record<string, unknown>;
}

async function connect(
  fetch: ReturnType<typeof vi.fn>,
  over: Partial<Parameters<typeof buildChannel>[0]> = {},
) {
  const server = buildChannel({
    apiKey: "jak_test",
    fetch: fetch as never,
    sleep: async () => {},
    nonce: "n0nce",
    ...over,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });

  const seen: Seen[] = [];
  const waiters: Array<{ method: string; resolve: (s: Seen) => void }> = [];
  client.fallbackNotificationHandler = async (n) => {
    const entry = { method: n.method, params: (n.params ?? {}) as Record<string, unknown> };
    seen.push(entry);
    for (const w of waiters.filter((w) => w.method === n.method)) w.resolve(entry);
  };

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  /** Resolves when the channel sends one of these, so no test sleeps. */
  function next(method: string, timeoutMs = 2000): Promise<Seen> {
    const already = seen.find((s) => s.method === method);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`nothing arrived on ${method}; saw ${seen.map((s) => s.method).join(", ") || "nothing"}`)),
        timeoutMs,
      );
      waiters.push({
        method,
        resolve: (s) => {
          clearTimeout(timer);
          resolve(s);
        },
      });
    });
  }

  async function prompt(over: Record<string, unknown> = {}) {
    await client.notification({
      method: PERMISSION_REQUEST,
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "Delete the staging database",
        input_preview: '{"command":"dropdb staging"}',
        ...over,
      },
    });
  }

  /** Lets the handler's promise chain run to completion before asserting. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  return { client, seen, next, prompt, settle, server };
}

const created = (fetch: ReturnType<typeof vi.fn>) =>
  JSON.parse(String(fetch.mock.calls.find((c) => c[1]?.method === "POST")?.[1]?.body ?? "{}"));

describe("what Claude Code can see", () => {
  it("declares itself a channel, and one that can take permission prompts", async () => {
    const fetch = vi.fn(async () => respond(200, approval()));
    const { client } = await connect(fetch);

    const caps = client.getServerCapabilities();
    expect(caps?.experimental?.["claude/channel"]).toEqual({});
    expect(caps?.experimental?.["claude/channel/permission"]).toEqual({});
  });

  it("tells the model what the events are and not to chatter on WhatsApp", async () => {
    const fetch = vi.fn(async () => respond(200, approval()));
    const { client } = await connect(fetch);

    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/<channel source="jabee"/);
    expect(instructions).toMatch(/costs the account one send/);
  });

  it("offers exactly one tool, for replying", async () => {
    const fetch = vi.fn(async () => respond(200, approval()));
    const { client } = await connect(fetch);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["reply"]);
    expect(tools[0]!.description).toMatch(/billed to the account|costs/i);
  });
});

describe("a permission prompt on a phone", () => {
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetch = vi.fn();
  });

  it("asks as an approval with an Edit button, and allows when approved", async () => {
    fetch
      .mockResolvedValueOnce(respond(201, approval()))
      .mockResolvedValueOnce(
        respond(200, approval({ status: "approved", responded_by: { type: "owner", id: "u1", name: "Mumen" } })),
      );
    const { next, prompt } = await connect(fetch);

    await prompt();
    const verdict = await next(PERMISSION_VERDICT);

    expect(verdict.params).toEqual({ request_id: "abcde", behavior: "allow" });
    const body = created(fetch);
    expect(body.title).toBe("Claude Code wants to run Bash");
    expect(body.options).toEqual(["approve", "skip", "edit"]);
    expect(body.body).toContain("dropdb staging");
  });

  it("denies when the person taps Skip", async () => {
    fetch
      .mockResolvedValueOnce(respond(201, approval()))
      .mockResolvedValueOnce(respond(200, approval({ status: "skipped" })));
    const { next, prompt } = await connect(fetch);

    await prompt();
    expect((await next(PERMISSION_VERDICT)).params["behavior"]).toBe("deny");
  });

  /**
   * The case the whole thing is for: "no, do it this way instead" is a
   * deny the agent can act on, not a dead end.
   */
  it("denies an amendment and puts their words into the session", async () => {
    fetch.mockResolvedValueOnce(respond(201, approval())).mockResolvedValueOnce(
      respond(
        200,
        approval({
          status: "edited",
          response_text: "not staging, drop the test one",
          responded_by: { type: "owner", id: "u1", name: "Mumen" },
        }),
      ),
    );
    const { next, prompt } = await connect(fetch);

    await prompt();
    const said = await next(CHANNEL_EVENT);
    const verdict = await next(PERMISSION_VERDICT);

    expect(String(said.params["content"])).toContain("not staging, drop the test one");
    expect((said.params["meta"] as Record<string, string>)["kind"]).toBe("person_said");
    expect((said.params["meta"] as Record<string, string>)["answered_by"]).toBe("Mumen");
    expect(verdict.params["behavior"]).toBe("deny");
  });

  /**
   * Silence is the only safe answer to a question nobody answered: the
   * terminal dialog is still open behind this, so inventing a deny would
   * kill a job no person refused.
   */
  it("sends no verdict when nobody answers, and says so in the session", async () => {
    fetch
      .mockResolvedValueOnce(respond(201, approval()))
      .mockResolvedValueOnce(respond(200, approval({ status: "expired" })));
    const { next, prompt, seen, settle } = await connect(fetch);

    await prompt();
    const note = await next(CHANNEL_EVENT);
    await settle();

    expect((note.params["meta"] as Record<string, string>)["kind"]).toBe("permission_unanswered");
    expect(String(note.params["content"])).toMatch(/still waiting at the terminal/);
    expect(seen.map((s) => s.method)).not.toContain(PERMISSION_VERDICT);
  });

  it("never turns a refused send into a verdict", async () => {
    fetch.mockResolvedValueOnce(
      respond(402, { error: "trial_used_up", detail: "Three free sends have been used." }),
    );
    const { next, prompt, seen, settle } = await connect(fetch);

    await prompt();
    const note = await next(CHANNEL_EVENT);
    await settle();

    expect((note.params["meta"] as Record<string, string>)["kind"]).toBe("permission_undeliverable");
    expect(String(note.params["content"])).toContain("trial_used_up");
    expect(String(note.params["content"])).toMatch(/Do not assume it was denied/);
    expect(seen.map((s) => s.method)).not.toContain(PERMISSION_VERDICT);
  });

  /**
   * A template parameter is rejected by Meta for a newline, a tab or four
   * spaces in a row, and an older Claude Code relays the model's text
   * without folding any of them.
   */
  it("flattens the relayed text, which arrives with whatever whitespace the model used", async () => {
    fetch
      .mockResolvedValueOnce(respond(201, approval()))
      .mockResolvedValueOnce(respond(200, approval({ status: "approved" })));
    const { next, prompt } = await connect(fetch);

    await prompt({
      description: "Run\n\nthe    migration",
      input_preview: '{"command":"psql\t-f up.sql"}',
    });
    await next(PERMISSION_VERDICT);

    const body = created(fetch);
    expect(body.body).not.toMatch(/[\n\t]/);
    expect(body.body).not.toMatch(/ {4}/);
    expect(body.body).toContain("Run the migration");
  });

  it("keys the request to this session, because five-letter ids repeat", async () => {
    fetch.mockResolvedValue(respond(201, approval({ status: "approved" })));
    const { prompt, next } = await connect(fetch, { nonce: "second" });

    await prompt();
    await next(PERMISSION_VERDICT);

    expect(created(fetch).external_id).toBe("cc-second-abcde");
  });

  it("asks only for as long as the answer is useful", async () => {
    fetch.mockResolvedValue(respond(201, approval({ status: "approved" })));
    const { prompt, next } = await connect(fetch, { expiresInMinutes: 7 });

    await prompt();
    await next(PERMISSION_VERDICT);

    expect(created(fetch).expires_in_minutes).toBe(7);
  });
});

describe("replying", () => {
  it("sends one button, so a tap reads as seen", async () => {
    const fetch = vi.fn(async () => respond(201, approval({ status: "pending" })));
    const { client } = await connect(fetch);

    const out = await client.callTool({ name: "reply", arguments: { text: "done, deployed" } });

    expect((out as { content: Array<{ text: string }> }).content[0]!.text).toBe("sent");
    const body = created(fetch);
    expect(body.options).toEqual(["skip"]);
    expect(body.title).toBe("done, deployed");
  });

  it("reports a refusal rather than pretending it sent", async () => {
    const fetch = vi.fn(async () =>
      respond(429, { error: "daily_limit_reached", detail: "200 requests in 24 hours." }),
    );
    const { client } = await connect(fetch);

    const out = (await client.callTool({ name: "reply", arguments: { text: "hello" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("daily_limit_reached");
  });
});
