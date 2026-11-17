"""The examples, driven against a stub rather than against production.

What these cannot prove is that a real key works and a real phone
buzzes; for that, run an example. What they do prove is that the request
shapes, the error mapping, the polling and the signature verification
are right, which is where a copied example goes wrong.

    python3 -m unittest discover -s python -p 'test_*.py'
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import io
import json
import threading
import time
import unittest
import urllib.error
from http.server import ThreadingHTTPServer

from heartbeat import check_in, delete_check, list_checks
from jabee import JabeeError, call, require_key
from request_approval import read_approval, request_approval, wait_for_answer
from send_alert import send_alert
from webhook_server import TOLERANCE_SECONDS, handle, make_handler, parse_signature, verify

KEY = "jak_test"
BASE = "https://example.test/api/v1"
OPTS = {"api_key": KEY, "base": BASE}
SECRET = "whsec_example"


class Recorder:
    """An opener that records the request and answers what you told it to."""

    def __init__(self, responses):
        self.queue = list(responses) if isinstance(responses, list) else [responses]
        self.calls = []

    def __call__(self, request):
        self.calls.append(
            {
                "url": request.full_url,
                "method": request.method,
                "headers": dict(request.headers),
                "body": json.loads(request.data.decode()) if request.data else None,
            }
        )
        answer = self.queue.pop(0) if len(self.queue) > 1 else self.queue[0]
        status = answer.get("status", 200)
        payload = json.dumps(answer.get("body", {})).encode()

        if status >= 400:
            raise urllib.error.HTTPError(
                request.full_url, status, "error", {}, io.BytesIO(payload)
            )

        class Response:
            def read(self_inner):
                return payload

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *_):
                return False

        return Response()


class KeyTests(unittest.TestCase):
    def test_missing_key_explains_itself(self):
        with self.assertRaisesRegex(RuntimeError, "JABEE_API_KEY is not set"):
            require_key({})
        self.assertEqual(require_key({"JABEE_API_KEY": "jak_x"}), "jak_x")


class AlertTests(unittest.TestCase):
    def test_posts_title_and_body_with_the_bearer_key(self):
        opener = Recorder({"body": {"id": "a_1", "status": "sent"}})
        alert = send_alert("Backup finished", "4.2GB", opener=opener, **OPTS)

        self.assertEqual(alert["id"], "a_1")
        self.assertEqual(opener.calls[0]["url"], f"{BASE}/alerts")
        self.assertEqual(opener.calls[0]["method"], "POST")
        self.assertEqual(opener.calls[0]["headers"]["Authorization"], f"Bearer {KEY}")
        self.assertEqual(opener.calls[0]["body"], {"title": "Backup finished", "body": "4.2GB"})

    def test_omits_what_you_did_not_set(self):
        opener = Recorder({"body": {"id": "a_2"}})
        send_alert("Just a title", opener=opener, **OPTS)
        self.assertEqual(opener.calls[0]["body"], {"title": "Just a title"})

    def test_blank_title_is_refused_before_the_request(self):
        opener = Recorder({"body": {}})
        with self.assertRaisesRegex(ValueError, "title is required"):
            send_alert("   ", opener=opener, **OPTS)
        self.assertEqual(opener.calls, [])

    def test_the_apis_own_words_survive(self):
        opener = Recorder(
            {
                "status": 429,
                "body": {
                    "error": "daily_limit_reached",
                    "detail": "An account can send 200 requests in 24 hours",
                },
            }
        )
        with self.assertRaises(JabeeError) as caught:
            send_alert("One too many", opener=opener, **OPTS)
        self.assertEqual(caught.exception.code, "daily_limit_reached")
        self.assertEqual(caught.exception.status, 429)
        self.assertIn("200 requests in 24 hours", str(caught.exception))

    def test_an_error_with_no_json_still_reads(self):
        opener = Recorder({"status": 502})
        with self.assertRaises(JabeeError) as caught:
            call("/alerts", method="POST", body={}, opener=opener, **OPTS)
        self.assertEqual(caught.exception.code, "http_502")


class ApprovalTests(unittest.TestCase):
    def test_asks_for_the_edit_button_and_an_expiry(self):
        opener = Recorder({"body": {"id": "ap_1", "status": "pending"}})
        request_approval(
            "Refund 4471?",
            "Never arrived",
            expires_in_minutes=30,
            external_id="refund-4471",
            opener=opener,
            **OPTS,
        )
        self.assertEqual(
            opener.calls[0]["body"],
            {
                "title": "Refund 4471?",
                "options": ["approve", "skip", "edit"],
                "body": "Never arrived",
                "external_id": "refund-4471",
                "expires_in_minutes": 30,
            },
        )

    def test_reading_one_back_quotes_the_id(self):
        opener = Recorder({"body": {"id": "ap/1", "status": "approved"}})
        read_approval("ap/1", opener=opener, **OPTS)
        self.assertEqual(opener.calls[0]["url"], f"{BASE}/approvals/ap%2F1")

    def test_waiting_stops_on_an_answer_and_backs_off_meanwhile(self):
        opener = Recorder(
            [
                {"body": {"id": "ap_1", "status": "pending"}},
                {"body": {"id": "ap_1", "status": "pending"}},
                {"body": {"id": "ap_1", "status": "edited", "response_text": "yes, but staging"}},
            ]
        )
        naps: list[float] = []
        answered = wait_for_answer(
            "ap_1",
            timeout_seconds=600,
            sleep=naps.append,
            now=lambda: 0.0,
            opener=opener,
            **OPTS,
        )
        self.assertEqual(answered["status"], "edited")
        self.assertEqual(len(opener.calls), 3)
        self.assertEqual([round(n, 2) for n in naps], [2.0, 3.2])

    def test_waiting_gives_up_rather_than_overrunning(self):
        opener = Recorder({"body": {"id": "ap_1", "status": "pending"}})
        answered = wait_for_answer(
            "ap_1",
            timeout_seconds=1,
            sleep=lambda _: None,
            now=lambda: 0.0,
            opener=opener,
            **OPTS,
        )
        self.assertEqual(answered["status"], "pending")
        self.assertEqual(len(opener.calls), 1)


class HeartbeatTests(unittest.TestCase):
    def test_first_check_in_sets_the_schedule(self):
        opener = Recorder({"body": {"name": "nightly", "created": True}})
        check = check_in("nightly", every="24h", grace="30m", recover=True, opener=opener, **OPTS)
        self.assertTrue(check["created"])
        self.assertEqual(
            opener.calls[0]["url"], f"{BASE}/heartbeat/nightly?every=24h&grace=30m&recover=true"
        )
        self.assertEqual(opener.calls[0]["method"], "POST")

    def test_a_later_check_in_can_inherit_it(self):
        opener = Recorder({"body": {"name": "nightly", "created": False}})
        check_in("nightly", opener=opener, **OPTS)
        self.assertEqual(opener.calls[0]["url"], f"{BASE}/heartbeat/nightly")

    def test_a_nameless_check_is_refused(self):
        with self.assertRaisesRegex(ValueError, "needs a name"):
            check_in("", **OPTS)

    def test_listing_and_deleting_use_the_plural_route(self):
        opener = Recorder({"body": {"heartbeats": []}})
        list_checks(opener=opener, **OPTS)
        delete_check("nightly", opener=opener, **OPTS)
        self.assertEqual(opener.calls[0]["url"], f"{BASE}/heartbeats")
        self.assertEqual(opener.calls[1]["url"], f"{BASE}/heartbeats/nightly")
        self.assertEqual(opener.calls[1]["method"], "DELETE")


def sign(body: bytes, timestamp: int) -> str:
    digest = hmac.new(
        SECRET.encode(), f"{timestamp}.".encode() + body, hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={digest}"


class SignatureTests(unittest.TestCase):
    def test_a_genuine_delivery_verifies(self):
        body = json.dumps({"id": "wh_1", "event": "approval.answered"}).encode()
        now = 1_700_000_000
        self.assertEqual(verify(body, sign(body, now), SECRET, now), (True, None))

    def test_a_tampered_body_does_not(self):
        body = json.dumps({"id": "wh_1"}).encode()
        now = 1_700_000_000
        header = sign(body, now)
        self.assertEqual(
            verify(body.replace(b"wh_1", b"wh_2"), header, SECRET, now), (False, "bad_signature")
        )

    def test_a_replay_from_last_week_does_not(self):
        body = b"{}"
        now = 1_700_000_000
        later = now + TOLERANCE_SECONDS + 1
        self.assertEqual(verify(body, sign(body, now), SECRET, later), (False, "stale_timestamp"))

    def test_a_missing_or_malformed_header_does_not(self):
        self.assertEqual(verify(b"{}", None, SECRET), (False, "malformed_signature"))
        self.assertEqual(verify(b"{}", "nonsense", SECRET), (False, "malformed_signature"))
        self.assertEqual(parse_signature("t=1,v1=ab"), (1, "ab"))


class HandleTests(unittest.TestCase):
    def test_only_an_approval_tells_you_to_act(self):
        lines: list[str] = []
        log = lines.append
        self.assertEqual(
            handle("approval.answered", {"approval": {"id": "a", "status": "approved"}}, log), "act"
        )
        self.assertEqual(
            handle("approval.answered", {"approval": {"id": "a", "status": "skipped"}}, log), "stop"
        )
        self.assertEqual(
            handle(
                "approval.answered",
                {"approval": {"id": "a", "status": "edited", "response_text": "no, staging"}},
                log,
            ),
            "stop",
        )
        self.assertEqual(handle("approval.expired", {"approval": {"id": "a"}}, log), "stop")
        self.assertEqual(handle("approval.failed", {"approval": {"id": "a"}}, log), "stop")
        self.assertEqual(handle("message.received", {"message": {"text": "ship it"}}, log), "noted")
        self.assertEqual(handle("something.new", {}, log), "ignored")
        self.assertIn("ignoring unknown event", lines[-1])


class ServerTests(unittest.TestCase):
    """End to end over a real socket: the raw body is the part that breaks."""

    def setUp(self):
        self.seen: list[str] = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(SECRET, self.seen.append))
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def post(self, body: bytes, headers: dict[str, str]):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/", body=body, headers={"Content-Type": "application/json", **headers})
        response = conn.getresponse()
        payload = response.read().decode()
        conn.close()
        return response.status, payload

    def test_accepts_a_signed_delivery_and_refuses_everything_else(self):
        body = json.dumps(
            {
                "id": "wh_1",
                "event": "approval.answered",
                "approval": {"id": "ap_1", "status": "approved"},
            }
        ).encode()
        now = int(time.time())

        status, _ = self.post(
            body, {"X-Jabee-Signature": sign(body, now), "X-Jabee-Event": "approval.answered"}
        )
        self.assertEqual(status, 204)
        self.assertIn("ap_1 approved", self.seen[-1])

        status, payload = self.post(body, {"X-Jabee-Signature": f"t={now},v1={'0' * 64}"})
        self.assertEqual(status, 401)
        self.assertEqual(payload, "bad_signature")

        status, payload = self.post(body, {})
        self.assertEqual(status, 401)
        self.assertEqual(payload, "malformed_signature")

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/")
        self.assertEqual(conn.getresponse().status, 405)
        conn.close()


if __name__ == "__main__":
    unittest.main()
