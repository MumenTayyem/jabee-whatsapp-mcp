import { describe, expect, it, vi } from "vitest";
import { createClient, JabeeError } from "../src/client.js";

/**
 * The half of this server that talks to Jabee.
 *
 * What matters is the behaviour an agent depends on: a retry that does
 * not ask somebody the same question twice, a rate limit that is waited
 * out exactly once, a daily limit that is not, and a wait loop that ends
 * rather than polling until the heat death of the universe.
 */
const KEY = "jak_test";

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

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

describe("creating a request", () => {
  it("sends the key and the body to the approvals endpoint", async () => {
    const fetch = vi.fn(async () => respond(201, approval()));
    const client = createClient({ apiKey: KEY, fetch: fetch as never });

    await client.create({ title: "Refund AED 450 to Sara", external_id: "refund-1043" });

    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.jabee.ai/api/v1/approvals");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string).external_id).toBe("refund-1043");
  });

  it("carries the API's own words out as the error", async () => {
    // The agent is going to put this in front of a person, so "429" on
    // its own is worth far less than what the API actually said.
    const fetch = vi.fn(async () =>
      respond(422, { error: "unknown_recipient", detail: "That team member has no verified phone." }),
    );
    const client = createClient({ apiKey: KEY, fetch: fetch as never });

    await expect(client.create({ title: "x" })).rejects.toMatchObject({
      code: "unknown_recipient",
      message: "That team member has no verified phone.",
      status: 422,
    });
  });

  it("throws a JabeeError even when the body is not JSON", async () => {
    const fetch = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const client = createClient({ apiKey: KEY, fetch: fetch as never });

    await expect(client.create({ title: "x" })).rejects.toBeInstanceOf(JabeeError);
  });
});

describe("rate limits", () => {
  it("waits out a per-key limit once and retries", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(429, { error: "rate_limited" }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(respond(201, approval()));
    const slept: number[] = [];
    const client = createClient({
      apiKey: KEY,
      fetch: fetch as never,
      sleep: async (ms) => void slept.push(ms),
    });

    const made = await client.create({ title: "x" });

    expect(made.id).toBe("a1");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([1000]);
  });

  /**
   * A daily limit cannot be waited out inside a tool call, so retrying
   * it just spends the remaining rate limit before failing anyway.
   */
  it("does not retry the daily limit", async () => {
    const fetch = vi.fn(async () =>
      respond(429, { error: "daily_limit_reached", detail: "200 a day." }),
    );
    const client = createClient({ apiKey: KEY, fetch: fetch as never, sleep: async () => {} });

    await expect(client.create({ title: "x" })).rejects.toMatchObject({
      code: "daily_limit_reached",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than retrying for ever", async () => {
    const fetch = vi.fn(async () => respond(429, { error: "rate_limited" }));
    const client = createClient({ apiKey: KEY, fetch: fetch as never, sleep: async () => {} });

    await expect(client.create({ title: "x" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("waiting for an answer", () => {
  it("returns as soon as somebody decides", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(200, approval()))
      .mockResolvedValueOnce(respond(200, approval({ status: "approved" })));
    const client = createClient({ apiKey: KEY, fetch: fetch as never, sleep: async () => {} });

    const out = await client.waitFor("a1", 60_000);

    expect(out.status).toBe("approved");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("hands back the pending request rather than waiting past its budget", async () => {
    // An agent blocked on a tool call is an agent whose client may time
    // out. Past the budget it gets the id and can poll.
    const fetch = vi.fn(async () => respond(200, approval()));
    let clock = 0;
    const client = createClient({
      apiKey: KEY,
      fetch: fetch as never,
      sleep: async (ms) => void (clock += ms),
    });
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock);

    const out = await client.waitFor("a1", 10_000);

    expect(out.status).toBe("pending");
    // Backing off rather than polling flat out: a handful of calls, not
    // one every two seconds for the whole budget.
    expect(fetch.mock.calls.length).toBeLessThan(6);
    vi.restoreAllMocks();
  });

  it("stops on an expiry as well as on an answer", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(200, approval()))
      .mockResolvedValueOnce(respond(200, approval({ status: "expired" })));
    const client = createClient({ apiKey: KEY, fetch: fetch as never, sleep: async () => {} });

    expect((await client.waitFor("a1", 60_000)).status).toBe("expired");
  });

  it("honours a custom base url, for a test or a self-hosted API", async () => {
    const fetch = vi.fn(async () => respond(200, approval()));
    const client = createClient({
      apiKey: KEY,
      baseUrl: "http://localhost:8080/api/v1/",
      fetch: fetch as never,
    });

    await client.get("a1");
    expect(fetch.mock.calls[0]![0]).toBe("http://localhost:8080/api/v1/approvals/a1");
  });

  it("escapes an id rather than pasting it into the path", async () => {
    const fetch = vi.fn(async () => respond(200, approval()));
    const client = createClient({ apiKey: KEY, fetch: fetch as never });

    await client.get("../../admin");
    expect(fetch.mock.calls[0]![0]).toContain("%2F");
  });
});
