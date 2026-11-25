#!/usr/bin/env python3
"""Parser and HTTP tests for the franchisee session walkthrough."""

from __future__ import annotations

import json
import os
import stat
import tempfile
import threading
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import StringIO
from pathlib import Path
from unittest import mock

import hcp_session
from hcp_session import (
    COOKIE_NAME,
    CompanyInfo,
    InputError,
    SavedCookie,
    SessionError,
    describe_age,
    lifetime_note,
    normalize_api_key,
    normalize_cookie,
    select_organization_id,
    session_from_set_cookie,
    summarize_company,
)


ORG_ID = "70e6c270-ae4d-4ffc-ade9-91c71ee721ee"
FRANCHISOR = "fran+chis/or==value"
FRANCHISEE = "franchisee-session-value"


class Handler(BaseHTTPRequestHandler):
    mode = "ok"
    requests: list[dict] = []

    def do_GET(self):
        self._record(b"")
        if self.path != "/company":
            self._reply(404, b"missing")
            return
        if Handler.mode == "unauthorized":
            self._reply(401, b'{"error":"unauthorized"}')
            return
        payload = json.dumps(
            {
                "id": ORG_ID,
                "name": "T1P Richmond",
                "time_zone": "America/New_York",
                "address": {"city": "Richmond", "state": "VA"},
            }
        ).encode()
        self._reply(200, payload, content_type="application/json")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self._record(body)
        if self.path != "/alpha/franchisee_sessions":
            self._reply(404, b"missing")
            return
        if Handler.mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "https://evil.example/phish")
            self.send_header("Set-Cookie", f"{COOKIE_NAME}=from-redirect; Path=/; HttpOnly")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            return
        if Handler.mode == "unauthorized":
            self._reply(401, f"rejected {FRANCHISOR}".encode())
            return
        if Handler.mode == "empty":
            self._reply(204, b"")
            return
        self.send_response(204)
        self.send_header("Set-Cookie", "other_cookie=ignore-me; Path=/")
        self.send_header(
            "Set-Cookie",
            f"{COOKIE_NAME}={FRANCHISEE}; Path=/; Max-Age=1209600; HttpOnly; Secure",
        )
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def _record(self, body: bytes) -> None:
        Handler.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "cookie": self.headers.get("Cookie"),
                "authorization": self.headers.get("Authorization"),
                "content_type": self.headers.get("Content-Type"),
                "body": body,
            }
        )

    def _reply(self, status: int, payload: bytes, content_type: str = "text/plain") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def log_message(self, fmt: str, *args) -> None:
        return


@contextmanager
def running_server():
    Handler.mode = "ok"
    Handler.requests = []
    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 0.2
    stop = threading.Event()

    def serve():
        while not stop.is_set():
            server.handle_request()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        stop.set()
        thread.join(timeout=2)
        server.server_close()


class NormalizeTests(unittest.TestCase):
    def test_bare_value_keeps_padding_and_symbols(self):
        self.assertEqual(normalize_cookie("  abc+def/ghi=  "), "abc+def/ghi=")

    def test_set_cookie_line_ignores_expires_comma(self):
        header = (
            "Set-Cookie: _housecall-web_session_with_domain=abc+def/ghi=; "
            "Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly"
        )
        self.assertEqual(normalize_cookie(header), "abc+def/ghi=")

    def test_cookie_header_picks_the_session_among_siblings(self):
        header = (
            "Cookie: ajs_user_id=123; "
            "_housecall-web_session_with_domain=sessionvalue; other=1"
        )
        self.assertEqual(normalize_cookie(header), "sessionvalue")

    def test_wrong_cookie_name_is_rejected(self):
        with self.assertRaises(InputError):
            normalize_cookie("other_cookie=abcdefgh; Path=/")
        with self.assertRaises(InputError):
            normalize_cookie("other=abcdefghij")

    def test_placeholder_and_header_injection_are_rejected(self):
        with self.assertRaises(InputError):
            normalize_cookie("AaBbCcDd...")
        with self.assertRaises(InputError):
            normalize_cookie("abcdefgh\r\nCookie: evil=1")

    def test_api_key_strips_authorization_prefixes(self):
        self.assertEqual(normalize_api_key("Authorization: Token secretvalue"), "secretvalue")
        self.assertEqual(normalize_api_key("Bearer secretvalue"), "secretvalue")
        self.assertEqual(normalize_api_key("token=secretvalue"), "secretvalue")


class CookieHeaderTests(unittest.TestCase):
    def test_last_session_cookie_wins_and_expires_keeps_its_comma(self):
        cookie, names = session_from_set_cookie(
            [
                "other=nope; Path=/",
                (
                    f"{COOKIE_NAME}=first; Path=/; "
                    "Expires=Wed, 21 Oct 2026 07:28:00 GMT"
                ),
                f"{COOKIE_NAME}=second; Path=/; Max-Age=1209600",
            ]
        )
        self.assertEqual(names, ["other", COOKIE_NAME, COOKIE_NAME])
        self.assertIsNotNone(cookie)
        assert cookie is not None
        self.assertEqual(cookie.value, "second")
        self.assertEqual(cookie.max_age, 1209600)
        self.assertEqual(lifetime_note(cookie), "Housecall Pro set Max-Age to 1209600 seconds (about 14 days).")
        self.assertEqual(cookie.expires, None)

    def test_expires_parses_when_max_age_is_absent(self):
        cookie, _names = session_from_set_cookie(
            [f"{COOKIE_NAME}=abcdefgh; Expires=Wed, 21 Oct 2026 07:28:00 GMT"]
        )
        assert cookie is not None
        self.assertEqual(cookie.expires, datetime(2026, 10, 21, 7, 28, tzinfo=timezone.utc))
        self.assertIn("2026-10-21 07:28 UTC", lifetime_note(cookie) or "")


class CompanyTests(unittest.TestCase):
    def test_root_company_payload(self):
        info = summarize_company(
            {
                "id": ORG_ID,
                "name": "T1P Richmond",
                "time_zone": "America/New_York",
                "address": {"city": "Richmond", "state": "VA"},
                "franchise_info": {"root_franchisor_id": "root-id", "franchisor_depth": 2},
            }
        )
        self.assertEqual(info.name, "T1P Richmond")
        self.assertEqual(info.organization_id, ORG_ID)
        self.assertEqual(info.id_field, "id")
        self.assertEqual(info.place, "Richmond, VA")
        self.assertEqual(info.root_franchisor_id, "root-id")
        self.assertEqual(info.franchisor_depth, 2)

    def test_nested_data_envelope_uses_uuid_and_business_name(self):
        info = summarize_company(
            {"data": {"business_name": "Nested HVAC", "uuid": ORG_ID}}
        )
        self.assertEqual(info.name, "Nested HVAC")
        self.assertEqual(info.organization_id, ORG_ID)
        self.assertEqual(info.id_field, "uuid")

    def test_explicit_id_must_be_one_the_company_returned(self):
        info = CompanyInfo(
            name="T1P Richmond",
            organization_id=ORG_ID,
            id_field="id",
            time_zone=None,
            place=None,
            root_franchisor_id=None,
            franchisor_depth=None,
            other_ids={"uuid": "11111111-1111-1111-1111-111111111111"},
        )
        self.assertEqual(select_organization_id(info, None), ORG_ID)
        self.assertEqual(
            select_organization_id(info, "11111111-1111-1111-1111-111111111111"),
            "11111111-1111-1111-1111-111111111111",
        )
        with self.assertRaises(SessionError):
            select_organization_id(info, "22222222-2222-2222-2222-222222222222")

    def test_missing_id_names_the_keys(self):
        with self.assertRaises(SessionError) as caught:
            summarize_company({"name": "No ID"})
        self.assertIn("name", str(caught.exception))


class SavedCookieTests(unittest.TestCase):
    def test_age_words_and_fourteen_day_boundary(self):
        now = datetime(2026, 10, 12, tzinfo=timezone.utc)
        self.assertEqual(describe_age(timedelta(days=2)), "2 days old")
        self.assertEqual(describe_age(timedelta(seconds=30)), "just saved")
        fresh = SavedCookie("a" * 16, now - timedelta(days=13))
        stale = SavedCookie("a" * 16, now - timedelta(days=14))
        unknown = SavedCookie("a" * 16, None)
        self.assertFalse(fresh.is_stale(now))
        self.assertTrue(stale.is_stale(now))
        self.assertTrue(unknown.is_stale(now))
        self.assertIn("past the 14-day window", stale.describe(now))

    def test_save_roundtrip_is_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hcp" / "franchisor-session.json"
            with mock.patch.object(hcp_session, "CONFIG_PATH", path):
                hcp_session.save_franchisor("a" * 20)
                loaded = hcp_session.load_saved_franchisor()
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertEqual(loaded.value, "a" * 20)
            self.assertFalse(loaded.is_stale())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)


class ExchangeTests(unittest.TestCase):
    def test_company_lookup_and_franchisee_exchange(self):
        with running_server() as base:
            client = hcp_session.HousecallClient(public_base=base, private_base=base, timeout=5)
            company = client.get_company("test-api-key")
            info = summarize_company(company)
            result = client.open_franchisee_session(FRANCHISOR, info.organization_id)

        self.assertEqual(info.name, "T1P Richmond")
        self.assertEqual(info.organization_id, ORG_ID)
        self.assertEqual(result.status, 204)
        self.assertEqual(result.cookie.value, FRANCHISEE)
        self.assertEqual(result.cookie.max_age, 1209600)

        company_call, exchange_call = Handler.requests
        self.assertEqual(company_call["path"], "/company")
        self.assertEqual(company_call["authorization"], "Token test-api-key")
        self.assertEqual(exchange_call["path"], "/alpha/franchisee_sessions")
        self.assertEqual(exchange_call["cookie"], f"{COOKIE_NAME}={FRANCHISOR}")
        self.assertEqual(exchange_call["content_type"], "application/json")
        self.assertEqual(json.loads(exchange_call["body"]), {"organization_id": ORG_ID})

    def test_redirect_sets_the_cookie_and_is_not_followed(self):
        with running_server() as base:
            Handler.mode = "redirect"
            client = hcp_session.HousecallClient(public_base=base, private_base=base, timeout=5)
            result = client.open_franchisee_session(FRANCHISOR, ORG_ID)

        self.assertEqual(result.status, 302)
        self.assertEqual(result.cookie.value, "from-redirect")
        self.assertEqual([item["path"] for item in Handler.requests], ["/alpha/franchisee_sessions"])

    def test_missing_set_cookie_and_rejected_key_are_explained(self):
        with running_server() as base:
            client = hcp_session.HousecallClient(public_base=base, private_base=base, timeout=5)
            Handler.mode = "empty"
            with self.assertRaises(SessionError) as missing:
                client.open_franchisee_session(FRANCHISOR, ORG_ID)
            Handler.mode = "unauthorized"
            Handler.requests = []
            with self.assertRaises(SessionError) as rejected:
                client.open_franchisee_session(FRANCHISOR, ORG_ID)
            with self.assertRaises(SessionError) as company:
                client.get_company("test-api-key")

        self.assertIn("Set-Cookie names: none", str(missing.exception))
        self.assertNotIn(FRANCHISOR, str(rejected.exception))
        self.assertIn("[redacted]", str(rejected.exception))
        self.assertIn("API key was rejected", str(company.exception))
        self.assertNotIn("test-api-key", str(company.exception))

    def test_run_prints_the_franchisee_cookie_for_the_company(self):
        company = {"id": ORG_ID, "name": "T1P Richmond"}
        exchanged = {}

        class FakeClient:
            def __init__(self, verbose: bool = False):
                self.verbose = verbose

            def get_company(self, api_key: str) -> dict:
                exchanged["api_key"] = api_key
                return company

            def open_franchisee_session(self, cookie: str, organization_id: str):
                exchanged["cookie"] = cookie
                exchanged["organization_id"] = organization_id
                return hcp_session.ExchangeResult(
                    status=204,
                    cookie=hcp_session.SessionCookie(value=FRANCHISEE, max_age=1209600),
                )

        stdout = StringIO()
        env = {
            "HCP_FRANCHISOR_COOKIE": FRANCHISOR,
            "HCP_API_KEY": "test-api-key-value",
            "HCP_ORG_ID": "",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(hcp_session, "HousecallClient", FakeClient):
                with mock.patch("sys.stdin.isatty", return_value=False):
                    with mock.patch("sys.stdout", stdout):
                        code = hcp_session.main(["--yes", "--no-clipboard"])

        self.assertEqual(code, 0)
        self.assertEqual(exchanged["api_key"], "test-api-key-value")
        self.assertEqual(exchanged["cookie"], FRANCHISOR)
        self.assertEqual(exchanged["organization_id"], ORG_ID)
        text = stdout.getvalue()
        self.assertIn("T1P Richmond", text)
        self.assertIn(ORG_ID, text)
        self.assertIn(FRANCHISEE, text)
        self.assertIn(f"Cookie: {COOKIE_NAME}={FRANCHISEE}", text)

    def test_help_exits_cleanly(self):
        import subprocess
        import sys

        completed = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("hcp_session.py")), "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0)
        self.assertIn("HCP_FRANCHISOR_COOKIE", completed.stdout)
        self.assertIn(COOKIE_NAME, completed.stdout)


if __name__ == "__main__":
    unittest.main()
