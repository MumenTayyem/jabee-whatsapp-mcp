"""Ask somebody before you do it, and wait for the answer.

The person gets Approve, Skip and — if you ask for it — an Edit button
that returns free text, because the answer is usually "yes, but not that
branch".

    python3 request_approval.py "Refund order 4471?" "Customer says it never arrived"
"""

from __future__ import annotations

import sys
import time
from typing import Any, Callable
from urllib.parse import quote

from jabee import call


def request_approval(
    title: str,
    body: str | None = None,
    url: str | None = None,
    options: list[str] | None = None,
    external_id: str | None = None,
    expires_in_minutes: int | None = None,
    **call_options: Any,
) -> dict[str, Any]:
    if not title or not title.strip():
        raise ValueError("title is required")

    payload: dict[str, Any] = {
        "title": title,
        # "approve" and "skip" are the default. Add "edit" for free text.
        "options": options or ["approve", "skip", "edit"],
    }
    if body:
        payload["body"] = body
    if url:
        payload["url"] = url
    if external_id:
        payload["external_id"] = external_id
    if expires_in_minutes:
        payload["expires_in_minutes"] = expires_in_minutes

    return call("/approvals", method="POST", body=payload, **call_options)


def read_approval(approval_id: str, **call_options: Any) -> dict[str, Any]:
    return call(f"/approvals/{quote(approval_id, safe='')}", **call_options)


def wait_for_answer(
    approval_id: str,
    timeout_seconds: float = 120.0,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    **call_options: Any,
) -> dict[str, Any]:
    """Polls until somebody answers, it expires, or we run out of patience.

    Backs off, because 60 calls a minute is the limit on a key and an
    approval nobody looks at until after lunch should not spend all of
    them getting there. A webhook is the better answer if you have a
    public URL — see webhook_server.py.
    """
    deadline = now() + timeout_seconds
    wait = 2.0

    while True:
        approval = read_approval(approval_id, **call_options)
        if approval.get("status") != "pending":
            return approval
        if now() + wait >= deadline:
            return approval
        sleep(wait)
        wait = min(wait * 1.6, 30.0)


if __name__ == "__main__":
    args = sys.argv[1:]
    created = request_approval(
        args[0] if args else "Approve this?",
        args[1] if len(args) > 1 else None,
        expires_in_minutes=30,
    )
    print(f"asked {created['id']}, waiting up to two minutes…")

    answered = wait_for_answer(created["id"])
    if answered.get("status") == "pending":
        print(f"still pending. Read it later: GET /approvals/{answered['id']}")
        raise SystemExit(0)

    text = answered.get("response_text")
    print(f"{answered['status']}" + (f": {text}" if text else ""))
    # An edited answer is not a yes. Act on the words, or refuse.
    raise SystemExit(0 if answered["status"] == "approved" else 1)
