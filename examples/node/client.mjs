/**
 * The whole client, in one file and with no dependencies.
 *
 * Every other example imports this. It is deliberately small enough to
 * paste into your own project and delete the parts you do not use.
 */

export const BASE = process.env.JABEE_BASE_URL ?? "https://api.jabee.ai/api/v1";

/** What the API said, rather than a status code on its own. */
export class JabeeError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "JabeeError";
    this.code = code;
    this.status = status;
  }
}

export function requireKey(env = process.env) {
  const key = env.JABEE_API_KEY;
  if (!key) {
    throw new Error(
      "JABEE_API_KEY is not set. Make a key under Management then Approvals " +
        "at https://app.jabee.ai/approvals — it begins jak_.",
    );
  }
  return key;
}

export async function call(path, { method = "GET", body, apiKey, base = BASE, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const res = await doFetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey ?? requireKey()}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    /**
     * The message is worth more than the status. `daily_limit_reached:
     * An account can send 200 requests in 24 hours` tells a person what
     * to do; `429` does not.
     */
    throw new JabeeError(
      json.error ?? `http_${res.status}`,
      json.detail ?? json.error ?? `The API answered ${res.status}.`,
      res.status,
    );
  }

  return json;
}
