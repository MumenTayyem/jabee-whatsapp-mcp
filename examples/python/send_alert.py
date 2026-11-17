"""Tell somebody that something happened.

One call, nothing to wait for. It reaches the handset the business
verified — never a customer.

    python3 send_alert.py "Backup finished" "4.2GB in 11 minutes"
"""

from __future__ import annotations

import sys
from typing import Any

from jabee import call


def send_alert(
    title: str,
    body: str | None = None,
    url: str | None = None,
    external_id: str | None = None,
    **options: Any,
) -> dict[str, Any]:
    if not title or not title.strip():
        raise ValueError("title is required")

    payload: dict[str, Any] = {"title": title}
    if body:
        payload["body"] = body
    if url:
        payload["url"] = url
    # Send the same external_id twice and you get the first request back
    # rather than a second message on somebody's phone.
    if external_id:
        payload["external_id"] = external_id

    return call("/alerts", method="POST", body=payload, **options)


if __name__ == "__main__":
    args = sys.argv[1:]
    alert = send_alert(args[0] if args else "Test alert from Jabee", args[1] if len(args) > 1 else None)
    print(f"sent {alert['id']} — {alert.get('status')}")
