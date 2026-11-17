/**
 * The Jabee approvals API, as the one thing this server talks to.
 *
 * Separate from the MCP wiring so it can be tested without a transport,
 * and so the retry and error handling live in one place rather than in
 * each tool.
 */

export interface Approval {
  id: string;
  status: "pending" | "approved" | "skipped" | "edited" | "expired" | "failed" | "cancelled";
  title: string;
  body?: string;
  url?: string | null;
  options: string[];
  external_id?: string | null;
  metadata?: Record<string, unknown>;
  response_text?: string | null;
  responded_at?: string | null;
  responded_by?: { type: string; id: string; name: string } | null;
  delivered_via?: string | null;
  /** What the calling system reported doing, and when it withdrew it. */
  outcome?: string | null;
  outcome_note?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreateInput {
  title: string;
  body?: string | undefined;
  url?: string | undefined;
  options?: string[] | undefined;
  external_id?: string | undefined;
  expires_in_minutes?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * An error carrying what the API said rather than a status code alone.
 *
 * The agent reading this is going to put the message in front of a
 * person, so "daily_limit_reached: An account can send 200 requests in
 * 24 hours" is worth far more than "429".
 */
export class JabeeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JabeeError";
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Injected in tests so a retry does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE = "https://api.jabee.ai/api/v1";

export function createClient(options: ClientOptions) {
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function call<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 429 && attempt < 2) {
      /**
       * Honour Retry-After once rather than giving up.
       *
       * The per-key limit is 60 calls a minute, which an agent polling a
       * pending approval can reach on its own. The daily limit cannot be
       * waited out in a retry and is left to the caller, which is why
       * only one of the two 429s is retried here.
       */
      const body = (await res
        .clone()
        .json()
        .catch(() => ({}))) as { error?: string };
      if (body.error !== "daily_limit_reached") {
        const after = Number(res.headers.get("Retry-After") ?? 2);
        await sleep(Math.min(Math.max(after, 1), 30) * 1000);
        return call<T>(path, init, attempt + 1);
      }
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      throw new JabeeError(
        body.error ?? `http_${res.status}`,
        body.detail ?? body.error ?? `The API answered ${res.status}.`,
        res.status,
      );
    }

    return (await res.json()) as T;
  }

  return {
    create(input: CreateInput): Promise<Approval> {
      return call<Approval>("/approvals", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    get(id: string): Promise<Approval> {
      return call<Approval>(`/approvals/${encodeURIComponent(id)}`);
    },

    /**
     * Waits for somebody to answer, or for the request to expire.
     *
     * Polling rather than a webhook, because an MCP server runs on the
     * developer's own machine behind whatever network they have and
     * cannot receive one. The interval starts short, because most
     * answers arrive within a minute of the phone buzzing, and backs off
     * so that an approval nobody looks at until the afternoon does not
     * spend the key's whole rate limit getting there.
     */
    async waitFor(id: string, timeoutMs: number): Promise<Approval> {
      const deadline = Date.now() + timeoutMs;
      let wait = 2000;

      for (;;) {
        const approval = await this.get(id);
        if (approval.status !== "pending") return approval;
        if (Date.now() + wait >= deadline) return approval;

        await sleep(wait);
        wait = Math.min(Math.round(wait * 1.6), 30_000);
      }
    },
  };
}
