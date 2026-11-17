"""The job that never ran.

A push-only alert cannot see this: if the cron line dies, nothing sends
and nothing is missed. So the job says "I ran" each time, and silence
past the deadline is what raises the alert.

    python3 heartbeat.py nightly-backup 15m 5m

In a crontab, the same thing with curl:

    0 3 * * * /usr/local/bin/backup && curl -fsS -X POST \
      -H "Authorization: Bearer $JABEE_API_KEY" \
      "https://api.jabee.ai/api/v1/heartbeat/nightly-backup?every=24h&grace=30m"

The `&&` matters: check in only when the job actually succeeded.
"""

from __future__ import annotations

import sys
from typing import Any
from urllib.parse import quote, urlencode

from jabee import call


def check_in(
    name: str,
    every: str | None = None,
    grace: str | None = None,
    recover: bool | None = None,
    **call_options: Any,
) -> dict[str, Any]:
    """`every` is required on the first check-in and sets the schedule.

    Later pings inherit it, so a second caller cannot silently re-time
    somebody else's check. `grace` is how late it may be before anybody
    is told.
    """
    if not name or not name.strip():
        raise ValueError("a heartbeat needs a name")

    query: dict[str, str] = {}
    if every:
        query["every"] = every
    if grace:
        query["grace"] = grace
    if recover is not None:
        query["recover"] = "true" if recover else "false"

    suffix = f"?{urlencode(query)}" if query else ""
    return call(f"/heartbeat/{quote(name, safe='')}{suffix}", method="POST", **call_options)


def list_checks(**call_options: Any) -> dict[str, Any]:
    return call("/heartbeats", **call_options)


def delete_check(name: str, **call_options: Any) -> dict[str, Any]:
    return call(f"/heartbeats/{quote(name, safe='')}", method="DELETE", **call_options)


if __name__ == "__main__":
    args = sys.argv[1:]
    check = check_in(
        args[0] if args else "example-job",
        every=args[1] if len(args) > 1 else "15m",
        grace=args[2] if len(args) > 2 else None,
        recover=True,
    )
    print(f"{'created' if check.get('created') else 'checked in'}: {check.get('name')}")
