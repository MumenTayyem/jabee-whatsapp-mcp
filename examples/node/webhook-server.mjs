/**
 * Receive the answer rather than polling for it.
 *
 * Signed the way Stripe signs: `X-Jabee-Signature: t=<unix>,v1=<hex>`,
 * where the hex is the HMAC-SHA256 of `<t>.<raw body>` under your
 * webhook secret. The timestamp is inside the signature so a captured
 * delivery cannot be replayed next week — which is why you must check
 * it, and why you must hash the RAW body, not a re-serialised object.
 *
 *   JABEE_WEBHOOK_SECRET=whsec_... node webhook-server.mjs 4000
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Five minutes either way. Clocks drift; a week-old delivery is an attack. */
export const TOLERANCE_SECONDS = 300;

export function parseSignature(header) {
  const parts = Object.fromEntries(
    String(header ?? "")
      .split(",")
      .map((pair) => pair.split("=").map((s) => s.trim()))
      .filter((pair) => pair.length === 2),
  );
  return { timestamp: Number(parts.t), v1: parts.v1 };
}

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verify(rawBody, header, secret, now = Date.now()) {
  const { timestamp, v1 } = parseSignature(header);
  if (!Number.isFinite(timestamp) || !v1) return { ok: false, reason: "malformed_signature" };

  const age = Math.abs(Math.floor(now / 1000) - timestamp);
  if (age > TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  // Equal length first: timingSafeEqual throws on a mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/** What to do with a delivery once it is known to be genuine. */
export function handle(event, payload, log = console.log) {
  switch (event) {
    case "approval.answered": {
      const approval = payload.approval;
      log(`${approval.id} ${approval.status}${approval.response_text ? `: ${approval.response_text}` : ""}`);
      // "edited" is not a yes. Read the words before acting.
      return approval.status === "approved" ? "act" : "stop";
    }
    case "approval.expired":
    case "approval.failed":
      log(`${payload.approval.id} ${event} — nobody decided, so do not act`);
      return "stop";
    case "message.received":
      // A verified handset typed something back. Treat it as an
      // instruction to your own system, never as an approval.
      log(`inbound: ${JSON.stringify(payload)}`);
      return "noted";
    default:
      log(`ignoring unknown event ${event}`);
      return "ignored";
  }
}

export function createWebhookServer({ secret, log = console.log } = {}) {
  return createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      // The raw bytes, exactly as sent. JSON.parse then re-stringify
      // would change the body and break the signature.
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const result = verify(rawBody, req.headers["x-jabee-signature"], secret);
      if (!result.ok) {
        log(`rejected: ${result.reason}`);
        res.writeHead(401).end(result.reason);
        return;
      }

      const body = JSON.parse(rawBody);
      handle(req.headers["x-jabee-event"] ?? body.event, body, log);
      // 2xx fast. Anything else is retried for about eleven hours.
      res.writeHead(204).end();
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.JABEE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("JABEE_WEBHOOK_SECRET is not set. Add a webhook under Management, then Approvals.");
    process.exit(1);
  }
  const port = Number(process.argv[2] ?? 4000);
  createWebhookServer({ secret }).listen(port, () => console.log(`listening on :${port}`));
}
