"""The whole client, in one file, standard library only.

Every other example imports this. `urllib` rather than `requests` so a
reader can run it with nothing installed; swap it for `httpx` in your own
project if you prefer.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

BASE = os.environ.get("JABEE_BASE_URL", "https://api.jabee.ai/api/v1")


class JabeeError(Exception):
    """What the API said, rather than a status code on its own."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def require_key(env: dict[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    key = source.get("JABEE_API_KEY")
    if not key:
        raise RuntimeError(
            "JABEE_API_KEY is not set. Make a key under Management then Approvals "
            "at https://app.jabee.ai/approvals — it begins jak_."
        )
    return key


def call(
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    api_key: str | None = None,
    base: str = BASE,
    opener: Any = None,
) -> dict[str, Any]:
    """One request. `opener` exists so the tests can answer without a network."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        f"{base}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {api_key or require_key()}",
            "Content-Type": "application/json",
        },
    )

    send = opener or urllib.request.urlopen
    try:
        with send(request) as response:
            raw = response.read().decode() or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as err:
        raw = err.read().decode() or "{}"
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {}
        raise JabeeError(
            parsed.get("error", f"http_{err.code}"),
            parsed.get("detail") or parsed.get("error") or f"The API answered {err.code}.",
            err.code,
        ) from None
