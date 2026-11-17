/**
 * The job that never ran.
 *
 * A push-only alert cannot see this: if the cron line dies, nothing
 * sends and nothing is missed. So the job says "I ran" each time, and
 * silence past the deadline is what raises the alert.
 *
 *   node heartbeat.mjs nightly-backup 15m 5m
 *
 * In a crontab, the same thing with curl:
 *
 *   0 3 * * * /usr/local/bin/backup && curl -fsS -X POST \
 *     -H "Authorization: Bearer $JABEE_API_KEY" \
 *     "https://api.jabee.ai/api/v1/heartbeat/nightly-backup?every=24h&grace=30m"
 *
 * The `&&` matters: check in only when the job actually succeeded.
 */
import { call } from "./client.mjs";

/**
 * `every` is required on the first check-in and sets the schedule;
 * later pings inherit it, so a second caller cannot silently re-time
 * somebody else's check. `grace` is how late it may be before anybody
 * is told.
 */
export function checkIn(name, { every, grace, recover } = {}, options = {}) {
  if (!name?.trim()) throw new Error("a heartbeat needs a name");
  const query = new URLSearchParams();
  if (every) query.set("every", every);
  if (grace) query.set("grace", grace);
  if (recover !== undefined) query.set("recover", String(recover));
  const suffix = query.toString() ? `?${query}` : "";
  return call(`/heartbeat/${encodeURIComponent(name)}${suffix}`, { method: "POST", ...options });
}

export function listChecks(options = {}) {
  return call("/heartbeats", options);
}

export function deleteCheck(name, options = {}) {
  return call(`/heartbeats/${encodeURIComponent(name)}`, { method: "DELETE", ...options });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, every, grace] = process.argv.slice(2);
  const check = await checkIn(name ?? "example-job", {
    every: every ?? "15m",
    grace,
    recover: true,
  });
  console.log(`${check.created ? "created" : "checked in"}: ${check.name}`);
}
