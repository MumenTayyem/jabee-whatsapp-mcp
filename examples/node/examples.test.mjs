/**
 * The examples, driven against a stub rather than against production.
 *
 * What these cannot prove is that a real key works and a real phone
 * buzzes; for that, run an example. What they do prove is that the
 * request shapes, the error mapping, the polling and the signature
 * verification are right, which is where a copied example goes wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request } from "node:http";

import { call, requireKey, JabeeError } from "./client.mjs";
import { sendAlert } from "./send-alert.mjs";
import { requestApproval, readApproval, waitForAnswer } from "./request-approval.mjs";
import { checkIn, listChecks, deleteCheck } from "./heartbeat.mjs";
import { verify, parseSignature, handle, createWebhookServer, TOLERANCE_SECONDS } from "./webhook-server.mjs";

const KEY = "jak_test";
const OPTS = { apiKey: KEY, base: "https://example.test/api/v1" };

/** A fetch that records what it was asked and answers what you told it to. */
function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.status === undefined || next.status < 400,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  return { fetchImpl, calls };
}

test("requireKey explains itself rather than throwing a TypeError later", () => {
  assert.throws(() => requireKey({}), /JABEE_API_KEY is not set/);
  assert.equal(requireKey({ JABEE_API_KEY: "jak_x" }), "jak_x");
});

test("an alert posts title and body, and sends the bearer key", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { id: "a_1", status: "sent" } });
  const alert = await sendAlert({ title: "Backup finished", body: "4.2GB" }, { ...OPTS, fetchImpl });

  assert.equal(alert.id, "a_1");
  assert.equal(calls[0].url, "https://example.test/api/v1/alerts");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body, { title: "Backup finished", body: "4.2GB" });
});

test("an alert omits what you did not set, rather than sending nulls", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { id: "a_2" } });
  await sendAlert({ title: "Just a title" }, { ...OPTS, fetchImpl });
  assert.deepEqual(calls[0].body, { title: "Just a title" });
});

test("an empty title is refused before the request is made", async () => {
  const { fetchImpl, calls } = stubFetch({ body: {} });
  // Thrown, not rejected: a bad argument is the caller's bug and should
  // not look like a network failure.
  assert.throws(() => sendAlert({ title: "   " }, { ...OPTS, fetchImpl }), /title is required/);
  assert.equal(calls.length, 0);
});

test("the API's own words survive, not just the status code", async () => {
  const { fetchImpl } = stubFetch({
    status: 429,
    body: { error: "daily_limit_reached", detail: "An account can send 200 requests in 24 hours" },
  });
  await assert.rejects(
    () => sendAlert({ title: "One too many" }, { ...OPTS, fetchImpl }),
    (err) => {
      assert.ok(err instanceof JabeeError);
      assert.equal(err.code, "daily_limit_reached");
      assert.equal(err.status, 429);
      assert.match(err.message, /200 requests in 24 hours/);
      return true;
    },
  );
});

test("a body with no JSON at all still produces a usable error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, text: async () => "" });
  await assert.rejects(
    () => call("/alerts", { method: "POST", body: {}, ...OPTS, fetchImpl }),
    (err) => err.code === "http_502" && /502/.test(err.message),
  );
});

test("an approval asks for the edit button and an expiry", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { id: "ap_1", status: "pending" } });
  await requestApproval(
    { title: "Refund 4471?", body: "Never arrived", expiresInMinutes: 30, externalId: "refund-4471" },
    { ...OPTS, fetchImpl },
  );
  assert.deepEqual(calls[0].body, {
    title: "Refund 4471?",
    body: "Never arrived",
    options: ["approve", "skip", "edit"],
    external_id: "refund-4471",
    expires_in_minutes: 30,
  });
});

test("reading one back url-encodes the id", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { id: "ap/1", status: "approved" } });
  await readApproval("ap/1", { ...OPTS, fetchImpl });
  assert.equal(calls[0].url, "https://example.test/api/v1/approvals/ap%2F1");
});

test("waiting stops the moment somebody answers, and backs off while they do not", async () => {
  const { fetchImpl, calls } = stubFetch([
    { body: { id: "ap_1", status: "pending" } },
    { body: { id: "ap_1", status: "pending" } },
    { body: { id: "ap_1", status: "edited", response_text: "yes, but staging" } },
  ]);
  const naps = [];
  const answered = await waitForAnswer("ap_1", {
    ...OPTS,
    fetchImpl,
    timeoutMs: 600_000,
    sleep: async (ms) => naps.push(ms),
  });

  assert.equal(answered.status, "edited");
  assert.equal(answered.response_text, "yes, but staging");
  assert.equal(calls.length, 3);
  assert.deepEqual(naps, [2000, 3200]);
});

test("waiting gives up rather than overrunning the deadline", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { id: "ap_1", status: "pending" } });
  const answered = await waitForAnswer("ap_1", {
    ...OPTS,
    fetchImpl,
    timeoutMs: 1000,
    sleep: async () => {},
  });
  assert.equal(answered.status, "pending");
  assert.equal(calls.length, 1, "one read, then no sleep that would pass the deadline");
});

test("a heartbeat sets the schedule on the first check-in", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { name: "nightly", created: true } });
  const check = await checkIn("nightly", { every: "24h", grace: "30m", recover: true }, { ...OPTS, fetchImpl });
  assert.equal(check.created, true);
  assert.equal(
    calls[0].url,
    "https://example.test/api/v1/heartbeat/nightly?every=24h&grace=30m&recover=true",
  );
  assert.equal(calls[0].init.method, "POST");
});

test("a later check-in can carry nothing and inherit the schedule", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { name: "nightly", created: false } });
  await checkIn("nightly", {}, { ...OPTS, fetchImpl });
  assert.equal(calls[0].url, "https://example.test/api/v1/heartbeat/nightly");
});

test("a nameless heartbeat is refused locally", () => {
  assert.throws(() => checkIn("", {}, OPTS), /needs a name/);
});

test("listing and deleting checks hit the plural route", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { heartbeats: [] } });
  await listChecks({ ...OPTS, fetchImpl });
  await deleteCheck("nightly", { ...OPTS, fetchImpl });
  assert.equal(calls[0].url, "https://example.test/api/v1/heartbeats");
  assert.equal(calls[1].url, "https://example.test/api/v1/heartbeats/nightly");
  assert.equal(calls[1].init.method, "DELETE");
});

const SECRET = "whsec_example";
const signed = (body, t) => `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;

test("a genuine delivery verifies", () => {
  const body = JSON.stringify({ id: "wh_1", event: "approval.answered" });
  const t = 1_700_000_000;
  assert.deepEqual(verify(body, signed(body, t), SECRET, t * 1000), { ok: true });
});

test("a tampered body does not", () => {
  const body = JSON.stringify({ id: "wh_1", event: "approval.answered" });
  const t = 1_700_000_000;
  const header = signed(body, t);
  const result = verify(body.replace("wh_1", "wh_2"), header, SECRET, t * 1000);
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("a replay from last week does not", () => {
  const body = "{}";
  const t = 1_700_000_000;
  const later = (t + TOLERANCE_SECONDS + 1) * 1000;
  assert.deepEqual(verify(body, signed(body, t), SECRET, later), { ok: false, reason: "stale_timestamp" });
});

test("a missing or malformed header does not", () => {
  assert.deepEqual(verify("{}", undefined, SECRET), { ok: false, reason: "malformed_signature" });
  assert.deepEqual(verify("{}", "nonsense", SECRET), { ok: false, reason: "malformed_signature" });
  assert.deepEqual(parseSignature("t=1,v1=ab"), { timestamp: 1, v1: "ab" });
});

test("a signature of the wrong length is rejected, not thrown over", () => {
  const t = Math.floor(Date.now() / 1000);
  assert.deepEqual(verify("{}", `t=${t},v1=abcd`, SECRET), { ok: false, reason: "bad_signature" });
});

test("only an approval tells you to act", () => {
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(handle("approval.answered", { approval: { id: "a", status: "approved" } }, log), "act");
  assert.equal(handle("approval.answered", { approval: { id: "a", status: "skipped" } }, log), "stop");
  assert.equal(
    handle("approval.answered", { approval: { id: "a", status: "edited", response_text: "no, staging" } }, log),
    "stop",
  );
  assert.equal(handle("approval.expired", { approval: { id: "a" } }, log), "stop");
  assert.equal(handle("approval.failed", { approval: { id: "a" } }, log), "stop");
  assert.equal(handle("message.received", { message: { text: "ship it" } }, log), "noted");
  assert.equal(handle("something.new", {}, log), "ignored");
  assert.match(lines.at(-1), /ignoring unknown event/);
});

/** The server end to end, over a real socket, because the raw body is the part that breaks. */
function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = request(
      { port, method: "POST", path: "/", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("the server accepts a signed delivery and refuses everything else", async () => {
  const seen = [];
  const server = createWebhookServer({ secret: SECRET, log: (l) => seen.push(l) });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();

  try {
    const body = JSON.stringify({
      id: "wh_1",
      event: "approval.answered",
      approval: { id: "ap_1", status: "approved" },
    });
    const t = Math.floor(Date.now() / 1000);

    const good = await post(port, body, {
      "X-Jabee-Signature": signed(body, t),
      "X-Jabee-Event": "approval.answered",
    });
    assert.equal(good.status, 204);
    assert.match(seen.at(-1), /ap_1 approved/);

    const bad = await post(port, body, { "X-Jabee-Signature": `t=${t},v1=${"0".repeat(64)}` });
    assert.equal(bad.status, 401);
    assert.equal(bad.body, "bad_signature");

    const unsigned = await post(port, body, {});
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.body, "malformed_signature");

    const wrongMethod = await new Promise((resolve, reject) => {
      const req = request({ port, method: "GET", path: "/" }, (res) => resolve(res.statusCode));
      req.on("error", reject);
      req.end();
    });
    assert.equal(wrongMethod, 405);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
