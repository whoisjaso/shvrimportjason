#!/usr/bin/env python3
"""Export tests against a local stand-in for both Housecall Pro APIs."""

from __future__ import annotations

import csv
import io
import json
import tempfile
import threading
import unittest
import urllib.parse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

import hcp_export
from hcp_export import AuthError, Housecall, Http, Throttle, export

API_KEY = "api-key-12345"
COOKIE = "own+session/cookie=="

JOBS = [
    {
        "id": "job_a",
        "invoice_number": "1001",
        "work_status": "complete rated",
        "customer": {"id": "cus_1", "first_name": "Ada", "last_name": "Lovelace"},
        "address": {"street": "1 Main St", "city": "Richmond", "state": "VA", "zip": "23220"},
        "subtotal": 123456,
        "total_amount": 120000,
        "assigned_employees": [
            {"id": "pro_1", "first_name": "Sam", "last_name": "Hill"},
            {"id": "pro_2", "first_name": "Jo", "last_name": None},
        ],
        "job_fields": {"job_type": {"id": "jt_1", "name": "Exterior"}},
    },
    {"id": "job_b", "invoice_number": "1002"},
    {"id": "job_c", "invoice_number": "1003"},
]

MATERIALS = {
    "job_a": [
        {
            "uuid": "jim_1",
            "name": "Paint",
            "quantity": "2.5",
            "unit_cost": 4599,
            "material_vendor": {"object": "material_vendor", "data": {"uuid": "matv_1", "name": "Sherwin"}},
            "material_purchase_status": {"data": {"uuid": "matps_1", "name": "Purchased"}},
            "material_source": "Store",
        }
    ],
    "job_b": [],
    "job_c": [{"uuid": "jim_2", "name": "Tape", "quantity": "1.0", "unit_cost": 350}],
}

MISC = {
    "job_a": [{"uuid": "mcli_1", "name": "Sub labor", "unit_cost": 25000, "qty_in_hundredths": 150, "quantity": 1.5}],
    "job_b": [{"uuid": "mcli_2", "name": "Dump fee", "unit_cost": 4000, "quantity": 1.0}],
    "job_c": [],
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: dict = {}

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        Handler.state["requests"].append(
            {"path": url.path, "query": query, "headers": dict(self.headers)}
        )
        if url.path.startswith("/alpha/"):
            if self.headers.get("Cookie") != f"_housecall-web_session_with_domain={COOKIE}":
                return self._json(401, {"error": "unauthorized"})
            if Handler.state.get("private_status"):
                return self._json(Handler.state["private_status"], {"error": "nope"})
        elif self.headers.get("Authorization") != f"Token {API_KEY}":
            return self._json(401, {"error": "unauthorized"})

        if url.path == "/company":
            return self._json(200, {"id": "org_1", "name": "T1P Richmond"})
        if url.path == "/jobs":
            page = int(query["page"][0])
            size = int(query["page_size"][0])
            chunk = JOBS[(page - 1) * size : page * size]
            pages = -(-len(JOBS) // size)
            return self._json(200, {"jobs": chunk, "page": page, "total_pages": pages})
        if url.path == "/alpha/job_costing/job_input_materials":
            job_id = query["job_uuid"][0]
            if job_id in Handler.state["rate_limit_once"]:
                Handler.state["rate_limit_once"].discard(job_id)
                return self._json(429, {"error": "slow down"}, {"Retry-After": "3"})
            if job_id in Handler.state["broken"]:
                return self._json(404, {"error": "missing"})
            return self._json(200, {"object": "list", "data": MATERIALS[job_id]})
        if url.path.startswith("/alpha/jobs/") and url.path.endswith("/miscellaneous_items"):
            job_id = url.path.split("/")[3]
            return self._json(200, {"object": "list", "data": MISC[job_id]})
        return self._json(404, {"error": "missing"})

    def _json(self, status, payload, headers=None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@contextmanager
def server():
    Handler.state = {"requests": [], "rate_limit_once": set(), "broken": set()}
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.sleeps: list[float] = []
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        patcher = mock.patch.object(hcp_export, "JOBS_PAGE_SIZE", 2)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def run_export(self, base: str, cookie: str = COOKIE) -> int:
        http = Http(Throttle(0), sleep=self.sleeps.append)
        client = Housecall(http, API_KEY, cookie, public_base=base, private_base=base)
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                return export(client, self.out)
        finally:
            http.close()

    def test_full_export_links_costs_to_jobs_across_pages_and_a_rate_limit(self):
        with server() as base:
            Handler.state["rate_limit_once"].add("job_a")
            self.assertEqual(self.run_export(base), 0)
            requests = Handler.state["requests"]

        self.assertEqual([r["query"]["page"] for r in requests if r["path"] == "/jobs"], [["1"], ["2"]])
        self.assertIn(3.0, self.sleeps)
        material_requests = [r for r in requests if r["path"] == "/alpha/job_costing/job_input_materials"]
        self.assertEqual(
            material_requests[0]["query"]["expand[]"],
            ["material_vendor", "material_purchase_status", "material_source"],
        )

        jobs = read_csv(self.out / "jobs.csv")
        self.assertEqual([row["job_id"] for row in jobs], ["job_a", "job_b", "job_c"])
        self.assertEqual(jobs[0]["customer_name"], "Ada Lovelace")
        self.assertEqual(jobs[0]["subtotal"], "1234.56")
        self.assertEqual(jobs[0]["assigned_employees"], "Sam Hill; Jo")
        self.assertEqual(jobs[0]["job_type"], "Exterior")

        materials = read_csv(self.out / "materials.csv")
        self.assertEqual([(row["job_id"], row["material_uuid"]) for row in materials], [("job_a", "jim_1"), ("job_c", "jim_2")])
        paint = materials[0]
        self.assertEqual(
            (paint["invoice_number"], paint["unit_cost"], paint["total_cost"], paint["vendor"], paint["vendor_uuid"]),
            ("1001", "45.99", "114.98", "Sherwin", "matv_1"),
        )
        self.assertEqual((paint["purchase_status"], paint["material_source"]), ("Purchased", "Store"))

        misc = read_csv(self.out / "miscellaneous_items.csv")
        self.assertEqual(
            [(row["job_id"], row["quantity"], row["unit_cost"], row["total_cost"]) for row in misc],
            [("job_a", "1.5", "250.00", "375.00"), ("job_b", "1", "40.00", "40.00")],
        )

    def test_failed_job_is_left_out_and_fetched_alone_on_rerun(self):
        with server() as base:
            Handler.state["broken"].add("job_b")
            self.assertEqual(self.run_export(base), 1)
            self.assertNotIn("job_b", {row["job_id"] for row in read_csv(self.out / "miscellaneous_items.csv")})

            Handler.state["broken"].clear()
            Handler.state["requests"].clear()
            self.assertEqual(self.run_export(base), 0)
            fetched = {
                r["query"]["job_uuid"][0]
                for r in Handler.state["requests"]
                if r["path"] == "/alpha/job_costing/job_input_materials"
            }

        self.assertEqual(fetched, {"job_b"})
        self.assertEqual([row["job_id"] for row in read_csv(self.out / "miscellaneous_items.csv")], ["job_a", "job_b"])

    def test_rejected_cookie_stops_the_run(self):
        with server() as base:
            with self.assertRaises(AuthError) as caught:
                self.run_export(base, cookie="expired-cookie")
        self.assertIn("session cookie", str(caught.exception))
        self.assertNotIn("expired-cookie", str(caught.exception))
        self.assertTrue((self.out / "jobs.csv").exists())

    def test_server_errors_back_off_then_give_up(self):
        with server() as base:
            Handler.state["private_status"] = 503
            self.assertEqual(self.run_export(base), 1)
        self.assertEqual(self.sleeps[:4], [2.0, 4.0, 8.0, 16.0])


class ThrottleTests(unittest.TestCase):
    def test_spaces_request_starts_by_the_interval(self):
        now = [100.0]
        slept: list[float] = []

        def sleep(seconds):
            slept.append(seconds)
            now[0] += seconds

        throttle = Throttle(0.5, clock=lambda: now[0], sleep=sleep)
        throttle.wait()
        now[0] += 0.2
        throttle.wait()
        now[0] += 0.9
        throttle.wait()
        self.assertEqual([round(s, 6) for s in slept], [0.3])


if __name__ == "__main__":
    unittest.main()
