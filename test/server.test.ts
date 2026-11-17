import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * The server, driven through a real MCP client over an in-memory
 * transport. Calling the handlers directly would not prove the thing
 * that actually breaks: whether the tools are registered under the names
 * and schemas an agent will use.
 */
const approval = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  status: "pending",
  title: "Refund AED 450 to Sara",
  options: ["approve", "skip"],
  expires_at: "2026-11-09T14:00:00.000Z",
  created_at: "2026-11-09T10:00:00.000Z",
  updated_at: "2026-11-09T10:00:00.000Z",
  ...over,
});

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connect(fetch: ReturnType<typeof vi.fn>) {
  const server = buildServer({
    apiKey: "jak_test",
    fetch: fetch as never,
    sleep: async () => {},
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("what an agent can see", () => {
  it("offers the three tools, named for what they do", async () => {
    const client = await connect(vi.fn(async () => respond(200, approval())));
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "ask_person",
      "check_approval",
      "tell_person",
    ]);
  });

  /**
   * The description is the whole of how a model decides to reach for
   * this rather than acting. It has to name the situation, not the
   * feature.
   */
  it("tells the model when to use it, in terms of what it is about to do", async () => {
    const client = await connect(vi.fn(async () => respond(200, approval())));
    const { tools } = await client.listTools();
    const ask = tools.find((t) => t.name === "ask_person")!;

    expect(ask.description).toMatch(/impossible to undo|expensive/i);
    expect(ask.description).toMatch(/refund/i);
  });
});

describe("asking somebody", () => {
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetch = vi.fn();
  });

  it("creates the request and reports the decision", async () => {
    fetch
      .mockResolvedValueOnce(respond(201, approval()))
      .mockResolvedValueOnce(
        respond(200, approval({ status: "approved", responded_by: { type: "owner", id: "u1", name: "Nour" } })),
      );
    const client = await connect(fetch);

    const out = await client.callTool({
      name: "ask_person",
      arguments: { title: "Refund AED 450 to Sara" },
    });

    const text = textOf(out);
    expect(text).toContain("status: approved");
    expect(text).toContain("Nour");
  });

  it("offers an Edit button only when amendment makes sense", async () => {
    fetch.mockResolvedValue(respond(201, approval({ status: "approved" })));
    const client = await connect(fetch);

    await client.callTool({ name: "ask_person", arguments: { title: "x" } });
    expect(JSON.parse(fetch.mock.calls[0]![1].body).options).toEqual(["approve", "skip"]);

    fetch.mockClear();
    await client.callTool({
      name: "ask_person",
      arguments: { title: "x", allow_amendment: true },
    });
    expect(JSON.parse(fetch.mock.calls[0]![1].body).options).toEqual([
      "approve",
      "skip",
      "edit",
    ]);
  });

  it("passes the amended words back to the agent", async () => {
    fetch.mockResolvedValueOnce(
      respond(201, approval({ status: "edited", response_text: "Refund AED 300, she keeps it" })),
    );
    const client = await connect(fetch);

    const out = await client.callTool({
      name: "ask_person",
      arguments: { title: "x", allow_amendment: true },
    });

    expect(textOf(out)).toContain("Refund AED 300, she keeps it");
  });

  /**
   * An agent blocked on a tool call is an agent whose client may time
   * out. Past the budget it gets the id and the instruction to poll.
   */
  it("returns the id rather than blocking when asked not to wait", async () => {
    fetch.mockResolvedValueOnce(respond(201, approval()));
    const client = await connect(fetch);

    const out = await client.callTool({
      name: "ask_person",
      arguments: { title: "x", wait_seconds: 0 },
    });

    expect(textOf(out)).toContain("id: a1");
    expect(textOf(out)).toContain("check_approval");
    // Created, and not polled even once.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says plainly when nobody could be reached", async () => {
    fetch.mockResolvedValueOnce(respond(201, approval({ status: "failed" })));
    const client = await connect(fetch);

    expect(textOf(await client.callTool({ name: "ask_person", arguments: { title: "x" } })))
      .toContain("could not be delivered");
  });

  it("hands the API's refusal to the agent rather than throwing", async () => {
    fetch.mockResolvedValueOnce(
      respond(429, { error: "daily_limit_reached", detail: "200 requests in 24 hours." }),
    );
    const client = await connect(fetch);

    const out = await client.callTool({ name: "ask_person", arguments: { title: "x" } });

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(textOf(out)).toContain("daily_limit_reached");
    expect(textOf(out)).toContain("200 requests in 24 hours.");
  });

  /**
   * Validated before anything is sent, and handed back as a readable
   * error rather than a thrown one: an agent can act on a message and
   * cannot act on an exception its client swallowed.
   */
  it("refuses a title the API would refuse anyway, without calling it", async () => {
    const client = await connect(fetch);

    const out = await client.callTool({ name: "ask_person", arguments: { title: "" } });

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("checking and telling", () => {
  it("reads a request back by id", async () => {
    const fetch = vi.fn(async () => respond(200, approval({ status: "skipped" })));
    const client = await connect(fetch);

    const out = await client.callTool({ name: "check_approval", arguments: { id: "a1" } });

    expect(textOf(out)).toContain("status: skipped");
  });

  it("says a withdrawn request is not to be acted on, with the reason", async () => {
    const fetch = vi.fn(async () =>
      respond(200, approval({ status: "cancelled", cancel_reason: "replaced" } as never)),
    );
    const client = await connect(fetch);

    const out = await client.callTool({ name: "check_approval", arguments: { id: "a1" } });

    expect(textOf(out)).toContain("status: cancelled");
    expect(textOf(out)).toContain("withdrawn by the system that asked: replaced");
    expect(textOf(out)).toContain("Do not act on it.");
  });

  it("repeats the outcome the caller reported", async () => {
    const fetch = vi.fn(async () =>
      respond(200, approval({ status: "approved", outcome: "posted", outcome_note: "at 10:02" } as never)),
    );
    const client = await connect(fetch);

    const out = await client.callTool({ name: "check_approval", arguments: { id: "a1" } });

    expect(textOf(out)).toContain("outcome reported: posted (at 10:02)");
  });

  it("sends a notification without waiting for anybody", async () => {
    const fetch = vi.fn(async () => respond(201, approval({ status: "pending" })));
    const client = await connect(fetch);

    const out = await client.callTool({
      name: "tell_person",
      arguments: { title: "Nightly build failed" },
    });

    expect(textOf(out)).toContain("Sent.");
    // One call: created and returned, never polled.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).options).toEqual(["skip"]);
  });
});
