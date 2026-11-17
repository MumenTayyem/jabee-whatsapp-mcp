# @jabee/mcp

Your agent messages you on WhatsApp when it is done — and asks you first
when it is about to do something you would want a say in.

```
JABEE_API_KEY=jak_... npx @jabee/mcp
```

Two jobs, one key, no phone number of your own.

## Three different things are called a WhatsApp MCP server

One of them can cost you your number, so it goes first.

| Kind | What it connects to | Can read your chats | Needs your own number | The catch |
|---|---|---|---|---|
| Unofficial client — QR-linked, usually built on whatsmeow or Baileys | Your personal WhatsApp, as a linked device | Yes | Yes — your own, personal one | WhatsApp's terms do not permit it, and the number can be banned |
| Your own Cloud API | A WhatsApp Business account you registered | No — only conversations on that business number | Yes, plus business verification and approved templates | Days of setup before the first message, and a template review each time the wording changes |
| A borrowed sender — what this is | Jabee's approved sender | No | No | It asks and tells your own verified people. It cannot reach your customers |

Most of the repositories you find by searching `whatsapp mcp` are the first
kind: a Go or Node client that scans a QR code, registers as a linked
device, stores your history in a local SQLite file and exposes it as MCP
tools. They are genuinely impressive, and several of them say the risk out
loud in their own READMEs. The risk is not the software, it is the account —
WhatsApp's terms do not permit third-party clients, and enforcement lands on
the phone number, which is the number your family messages you on.

That is also the trade: a personal account is the only way to read your own
chats from an agent. **No official route can do that**, including this one.
If that is what you came for, this is the wrong package.

This is not a disinterested opinion and it would be silly to pretend
otherwise: Jabee sells the third kind. The rule it keeps for itself is in
the open — no unofficial library has ever been in this product. The longer
comparison is at [jabee.ai/docs/whatsapp-mcp/](https://jabee.ai/docs/whatsapp-mcp/).

## Tell me when it is finished

You gave an agent twenty minutes of work and walked away. When it
finishes, `tell_person` sends you a line on WhatsApp — in the agent's own
words, so it says what it actually did rather than that something
happened.

The usual answer to this is a push service and another app on your phone
to install and then ignore. This lands on the one that is already open,
and the same key can also ask you a question, which a notifier cannot.

Put this in your `CLAUDE.md`, or whatever your agent reads, because it
will not call a tool it was not told about:

```
When a long task finishes, call tell_person with one line on what
changed. Before anything irreversible — a force push, a production
deploy, a migration, deleting a branch, spending money — call
ask_person and wait for the answer.
```

## Ask me before you do that

The other half, and the reason this is not just a notifier. Your agent is
about to issue a refund, send a quote, post something publicly, or email
a list. `ask_person` asks somebody first, waits, and hands back the
answer. The person gets buttons on their phone.

## Why this rather than building it

You can build this on Twilio in a weekend, and several people have. What
is in the weekend: a number, a message template Meta has to approve, a
webhook, a state table, and a decision about what happens when two people
tap at once or nobody taps at all.

This needs **no phone number of your own**, because the number and the
template are Jabee's and already approved. It also already handles the
parts that are easy to get wrong:

- Two people answering at once is settled in one statement, so exactly
  one wins and the second is told what happened.
- A request nobody answers expires rather than hanging your agent for
  ever.
- An Edit button returns free text, because the answer is often "yes, but
  change this" rather than yes or no.
- Sending the same `external_id` twice returns the request you already
  made, so a retry does not ask somebody the same question twice.

## Setting it up

Make a key under **Management, then Approvals,** at
[app.jabee.ai](https://app.jabee.ai/approvals). It starts `jak_`.

Then, in your MCP client's configuration:

```json
{
  "mcpServers": {
    "jabee": {
      "command": "npx",
      "args": ["-y", "@jabee/mcp"],
      "env": { "JABEE_API_KEY": "jak_..." }
    }
  }
}
```

The person who answers needs a verified phone, which they get by sending
one message from a link in the dashboard. Until they do, requests fall
back to email.

## The tools

### `tell_person`

One-way, and the one to reach for first. A build failed, an order
shipped, a run finished. Takes the same `title` and `body` as
`ask_person`, reaches your own verified team and never your customers,
and returns as soon as it is sent rather than waiting for anybody.

### `ask_person`

Asks for a decision and waits for it.

| | |
|---|---|
| `title` | The decision, in one line. Required. |
| `body` | Why you are asking. |
| `url` | A link to the thing being decided. |
| `allow_amendment` | Offer an Edit button that takes free text. |
| `external_id` | Your own id, so a retry is safe. |
| `expires_in_minutes` | How long the decision stays useful. |
| `wait_seconds` | How long to block. Defaults to 120. `0` returns at once. |

Returns the decision, or the request id if nobody has answered within
`wait_seconds`. Two minutes is the default because an agent blocked on a
tool call is an agent whose client may time out.

### `check_approval`

Reads a request back by id, for when `ask_person` returned while still
pending. It also reports a request that was cancelled ("Do not act on it")
and any outcome recorded against it, so an agent that comes back later does
not act on a decision somebody has since withdrawn.

## The Claude Code channel

The same package ships a second entry point: a **channel** for Claude
Code, which puts the permission prompt on your phone.

```
JABEE_API_KEY=jak_... claude --dangerously-load-development-channels server:jabee
```

When Claude asks to run `Bash`, `Write` or `Edit`, the prompt arrives on
WhatsApp with Approve, Skip and Edit. The terminal dialog stays open the
whole time and **the first answer wins** — the keyboard or the phone,
whichever you reach first. Claude Code's own channels are Telegram,
Discord and iMessage; this is the one for the app that is already open.

Add it to `.mcp.json` (or `~/.claude.json` with an absolute path) first:

```json
{
  "mcpServers": {
    "jabee": {
      "command": "npx",
      "args": ["-y", "--package=@jabee/mcp", "jabee-channel"],
      "env": { "JABEE_API_KEY": "jak_..." }
    }
  }
}
```

Three things worth knowing before you rely on it:

- **The development flag is required, and that is not our choice.**
  Channels are a research preview, and during it Claude Code registers
  only channels on an Anthropic-maintained allowlist, or on an
  organisation's own `allowedChannelPlugins`. Without one of those the
  channel is silently not registered, so `--dangerously-load-development-channels`
  is the honest instruction rather than a footnote. A Team or Enterprise
  admin can allowlist it instead.
- **Tapping Edit denies the command and sends Claude your words**, which
  is usually what you meant: "no, the staging one". Approve allows, Skip
  denies.
- **Nobody answering sends nothing.** If the request expires or cannot be
  delivered, no verdict is sent and the prompt is still waiting at your
  terminal. An invented denial would kill a job no person refused.

It also gives Claude one tool, `reply`, for answering you on WhatsApp.
Every reply is a real message billed to the account, so it is told not to
narrate progress with it.

One environment variable beyond the key:
`JABEE_PERMISSION_EXPIRY_MINUTES` (default 15, floor 5). There is nobody
to address — a request goes to the one phone this business has verified,
or the account owner's.

## Limits

60 API calls a minute per key, and 200 new requests per business in any
24 hours. A repeated `external_id` does not count against the daily
figure.

The daily limit is there because every request is a message from a number
every Jabee business shares, and one number's standing with Meta is
everybody's. If you genuinely need more, email hello@jabee.ai.

## What it costs

$29 a month for 500 notifications and approvals together, then 3 cents
each. They share a plan because a notification is an approval without a
question. The first three are free, so you can watch one land on your
phone before paying for anything.

For one notification to one phone, cheaper and free things exist and we
would rather say so: CallMeBot's free API and ntfy both do that, and $29 is
not worth paying for one line a week. What $29 buys is the case they do not
serve — a team: a request that reaches the right person, an acknowledgement,
an answer that comes back, and an audit trail of who decided what.

## Not for messaging customers

This reaches people on your own team who have verified a phone with us.
It cannot message your customers, deliberately: a shared number messaging
strangers is what gets numbers banned. To reach customers you connect
your own WhatsApp number, and then it is your number and your
relationship.

## Documentation

[The HTTP API](https://jabee.ai/docs/approvals/) underneath this, with
signature verification in Node and Python if you would rather use a
webhook than an agent.

## Without MCP

If your agent does not speak MCP — or you are calling from cron, CI or a
web handler rather than from an agent — the same four jobs are a plain HTTP
call. [`examples/`](examples/) has them in Node and in Python, with no SDK
and no dependencies: send an alert, ask and wait for an answer, check in a
scheduled job so silence raises the alarm, and receive the answer by signed
webhook. Both sets have tests that run against a stub, so you can check them
without a key.

## About this repository

This repository is the published source of **`@jabee/mcp` 0.1.3** — the
package `npx` installs, copied here so you can read it before running it
against your own account. It is not the Jabee service: the WhatsApp sender
and the Meta-approved template are the parts that cannot be installed.

Issues and questions belong [here](https://github.com/MumenTayyem/jabee-whatsapp-mcp/issues),
or hello@jabee.ai. If the version above is behind the one on npm, the npm
one is current and this copy is stale — say so in an issue and it will be
updated.
