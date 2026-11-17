/**
 * Tell somebody that something happened.
 *
 * One call, nothing to wait for. A backup finished, a deploy went out, a
 * customer paid. It reaches the handset the business verified — never a
 * customer.
 *
 *   node send-alert.mjs "Backup finished" "4.2GB in 11 minutes"
 */
import { call } from "./client.mjs";

/**
 * @param {{title: string, body?: string, url?: string, externalId?: string}} input
 */
export function sendAlert(input, options = {}) {
  if (!input.title?.trim()) throw new Error("title is required");
  return call("/alerts", {
    method: "POST",
    body: {
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.url ? { url: input.url } : {}),
      // Send the same external_id twice and you get the first request
      // back rather than a second message on somebody's phone.
      ...(input.externalId ? { external_id: input.externalId } : {}),
    },
    ...options,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [title, body] = process.argv.slice(2);
  const alert = await sendAlert({ title: title ?? "Test alert from Jabee", body });
  console.log(`sent ${alert.id} — ${alert.status}`);
}
