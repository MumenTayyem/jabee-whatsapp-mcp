/**
 * Ask somebody before you do it, and wait for the answer.
 *
 * The person gets Approve, Skip and — if you ask for it — an Edit button
 * that returns free text, because the answer is usually "yes, but not
 * that branch".
 *
 *   node request-approval.mjs "Refund order 4471?" "Customer says it never arrived"
 */
import { call } from "./client.mjs";

export function requestApproval(input, options = {}) {
  if (!input.title?.trim()) throw new Error("title is required");
  return call("/approvals", {
    method: "POST",
    body: {
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.url ? { url: input.url } : {}),
      // "approve" and "skip" are the default. Add "edit" for free text.
      options: input.options ?? ["approve", "skip", "edit"],
      ...(input.externalId ? { external_id: input.externalId } : {}),
      ...(input.expiresInMinutes ? { expires_in_minutes: input.expiresInMinutes } : {}),
    },
    ...options,
  });
}

export function readApproval(id, options = {}) {
  return call(`/approvals/${encodeURIComponent(id)}`, options);
}

/**
 * Polls until somebody answers, the request expires, or we run out of
 * patience.
 *
 * Backs off, because 60 calls a minute is the limit on a key and an
 * approval nobody looks at until after lunch should not spend all of
 * them getting there. A webhook is the better answer if you have a
 * public URL — see webhook-server.mjs.
 */
export async function waitForAnswer(id, { timeoutMs = 120_000, sleep, ...options } = {}) {
  const nap = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let wait = 2000;

  for (;;) {
    const approval = await readApproval(id, options);
    if (approval.status !== "pending") return approval;
    if (Date.now() + wait >= deadline) return approval;
    await nap(wait);
    wait = Math.min(Math.round(wait * 1.6), 30_000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [title, body] = process.argv.slice(2);
  const created = await requestApproval({
    title: title ?? "Approve this?",
    body,
    expiresInMinutes: 30,
  });
  console.log(`asked ${created.id}, waiting up to two minutes…`);

  const answered = await waitForAnswer(created.id);
  if (answered.status === "pending") {
    console.log(`still pending. Read it later: GET /approvals/${answered.id}`);
    process.exit(0);
  }
  console.log(`${answered.status}${answered.response_text ? `: ${answered.response_text}` : ""}`);
  // An edited answer is not a yes. Act on the words, or refuse.
  process.exit(answered.status === "approved" ? 0 : 1);
}
