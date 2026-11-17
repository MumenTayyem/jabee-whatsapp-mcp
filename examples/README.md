# Examples

Four things the Jabee API does, in Node and in Python, with no SDK and no
dependencies — `fetch` and `node:crypto` on one side, `urllib` and `hmac` on
the other. Copy a file, set `JABEE_API_KEY`, run it.

The MCP server in this repository is a convenience over the same HTTP API.
If your agent does not speak MCP, or you are calling from cron or CI rather
than from an agent, these are the whole of what you need.

| What | Node | Python |
|---|---|---|
| Tell somebody something happened | [`node/send-alert.mjs`](node/send-alert.mjs) | [`python/send_alert.py`](python/send_alert.py) |
| Ask somebody, and wait for the answer | [`node/request-approval.mjs`](node/request-approval.mjs) | [`python/request_approval.py`](python/request_approval.py) |
| Notice the job that never ran | [`node/heartbeat.mjs`](node/heartbeat.mjs) | [`python/heartbeat.py`](python/heartbeat.py) |
| Receive the answer by signed webhook | [`node/webhook-server.mjs`](node/webhook-server.mjs) | [`python/webhook_server.py`](python/webhook_server.py) |

## Running them

```
export JABEE_API_KEY=jak_...          # Management, then Approvals, at app.jabee.ai
node node/send-alert.mjs "Backup finished" "4.2GB in 11 minutes"
python3 python/send_alert.py "Backup finished" "4.2GB in 11 minutes"
```

The key begins `jak_` and is shown once. Three sends are free, so you can
watch one arrive on your phone before paying for anything.

## The tests

Every example exports its functions, so the tests drive them against a stub
server on localhost rather than against production. No key needed, nothing
sent to anybody's phone:

```
node --test node/*.test.mjs          # Node 20 or newer, no install
python3 -m unittest discover -s python -p 'test_*.py'
```

Or both at once, from the package root: `npm run test:examples`.

What the tests cannot check is that your own key works and that a message
reaches your own handset. For that, run an example.

## The API in one paragraph

Base `https://api.jabee.ai/api/v1`, `Authorization: Bearer jak_...`,
JSON in and out. `POST /alerts` sends; `POST /approvals` asks and returns a
request whose `status` is `pending` until somebody taps, then `approved`,
`skipped`, `edited`, `expired`, `failed` or `cancelled`. `GET /approvals/:id`
reads one back. `POST /heartbeat/:name?every=15m` says a job ran, and
silence past the deadline is what raises the alert. Titles are capped at 120
characters, bodies at 2000. 60 calls a minute per key, 200 new requests per
business in 24 hours. Full reference: https://jabee.ai/docs/approvals/
