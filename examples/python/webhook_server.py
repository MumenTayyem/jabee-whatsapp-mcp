"""Receive the answer rather than polling for it.

Signed the way Stripe signs: `X-Jabee-Signature: t=<unix>,v1=<hex>`,
where the hex is the HMAC-SHA256 of `<t>.<raw body>` under your webhook
secret. The timestamp is inside the signature so a captured delivery
cannot be replayed next week — which is why you must check it, and why
you must hash the RAW body, not a re-serialised dict.

    JABEE_WEBHOOK_SECRET=whsec_... python3 webhook_server.py 4000
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

# Five minutes either way. Clocks drift; a week-old delivery is an attack.
TOLERANCE_SECONDS = 300


def parse_signature(header: str | None) -> tuple[int | None, str | None]:
    parts: dict[str, str] = {}
    for pair in (header or "").split(","):
        if "=" in pair:
            name, _, value = pair.partition("=")
            parts[name.strip()] = value.strip()
    try:
        timestamp = int(parts["t"])
    except (KeyError, ValueError):
        return None, None
    return timestamp, parts.get("v1")


def verify(
    raw_body: bytes,
    header: str | None,
    secret: str,
    now: float | None = None,
) -> tuple[bool, str | None]:
    """Returns (ok, reason_if_not)."""
    timestamp, v1 = parse_signature(header)
    if timestamp is None or not v1:
        return False, "malformed_signature"

    moment = time.time() if now is None else now
    if abs(int(moment) - timestamp) > TOLERANCE_SECONDS:
        return False, "stale_timestamp"

    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, v1):
        return False, "bad_signature"
    return True, None


def handle(event: str, payload: dict[str, Any], log: Callable[[str], None] = print) -> str:
    """What to do with a delivery once it is known to be genuine."""
    if event == "approval.answered":
        approval = payload["approval"]
        text = approval.get("response_text")
        log(f"{approval['id']} {approval['status']}" + (f": {text}" if text else ""))
        # "edited" is not a yes. Read the words before acting.
        return "act" if approval["status"] == "approved" else "stop"

    if event in ("approval.expired", "approval.failed"):
        log(f"{payload['approval']['id']} {event} — nobody decided, so do not act")
        return "stop"

    if event == "message.received":
        # A verified handset typed something back. Treat it as an
        # instruction to your own system, never as an approval.
        log(f"inbound: {json.dumps(payload)}")
        return "noted"

    log(f"ignoring unknown event {event}")
    return "ignored"


def make_handler(secret: str, log: Callable[[str], None] = print):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 — the name is BaseHTTPRequestHandler's
            length = int(self.headers.get("Content-Length") or 0)
            # The raw bytes, exactly as sent. Parsing then re-serialising
            # would change the body and break the signature.
            raw_body = self.rfile.read(length)

            ok, reason = verify(raw_body, self.headers.get("X-Jabee-Signature"), secret)
            if not ok:
                log(f"rejected: {reason}")
                self.send_response(401)
                self.end_headers()
                self.wfile.write((reason or "rejected").encode())
                return

            body = json.loads(raw_body or b"{}")
            handle(self.headers.get("X-Jabee-Event") or body.get("event", ""), body, log)
            # 2xx fast. Anything else is retried for about eleven hours.
            self.send_response(204)
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            self.send_response(405)
            self.end_headers()

        def log_message(self, *args: Any) -> None:
            """Quiet: the handler logs what matters itself."""

    return Handler


if __name__ == "__main__":
    webhook_secret = os.environ.get("JABEE_WEBHOOK_SECRET")
    if not webhook_secret:
        print("JABEE_WEBHOOK_SECRET is not set. Add a webhook under Management, then Approvals.")
        raise SystemExit(1)

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4000
    print(f"listening on :{port}")
    ThreadingHTTPServer(("", port), make_handler(webhook_secret)).serve_forever()
