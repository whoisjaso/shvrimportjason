#!/usr/bin/env python3
"""Export every job, plus its job costing materials and miscellaneous items, to CSV.

    python3 hcp_export.py

Jobs come from the public API (API key). Materials and miscellaneous items
come from the private /alpha/ API, using your own signed-in browser session
cookie. Requests are spaced out (--delay) and 429 / 5xx answers back off.

Progress is saved per job in costs.jsonl, so a rerun into the same output
directory skips jobs it already fetched. Pass --fresh to start over.
"""

from __future__ import annotations

import argparse
import csv
import http.client
import json
import os
import ssl
import sys
import time
import urllib.parse
from decimal import Decimal, InvalidOperation
from pathlib import Path

from hcp_session import (
    COOKIE_NAME,
    PRIVATE_BASE,
    PUBLIC_BASE,
    InputError,
    SessionError,
    normalize_api_key,
    normalize_cookie,
    prompt_hidden,
    read_secret_file,
    redact,
    truncate,
)

USER_AGENT = "hcp-export/1.0"
DEFAULT_DELAY = 0.1
JOBS_PAGE_SIZE = 100
MAX_RATE_LIMIT_RETRIES = 6
MAX_SERVER_RETRIES = 4
DEFAULT_RETRY_AFTER = 5.0
MATERIAL_EXPAND = ("material_vendor", "material_purchase_status", "material_source")

JOB_COLUMNS = [
    "job_id",
    "invoice_number",
    "description",
    "work_status",
    "customer_id",
    "customer_name",
    "customer_company",
    "customer_email",
    "customer_mobile",
    "street",
    "street_line_2",
    "city",
    "state",
    "zip",
    "scheduled_start",
    "scheduled_end",
    "on_my_way_at",
    "started_at",
    "completed_at",
    "created_at",
    "updated_at",
    "canceled_at",
    "deleted_at",
    "subtotal",
    "total_amount",
    "outstanding_balance",
    "assigned_employees",
    "assigned_employee_ids",
    "tags",
    "lead_source",
    "job_type",
    "business_unit",
    "original_estimate_id",
    "recurrence_rule",
]

MATERIAL_COLUMNS = [
    "job_id",
    "invoice_number",
    "material_uuid",
    "name",
    "part_number",
    "description",
    "quantity",
    "unit_of_measure",
    "unit_cost",
    "total_cost",
    "vendor",
    "vendor_uuid",
    "purchase_status",
    "purchase_status_uuid",
    "material_source",
    "material_source_uuid",
    "pricebook_material_uuid",
]

MISC_COLUMNS = [
    "job_id",
    "invoice_number",
    "item_uuid",
    "name",
    "description",
    "quantity",
    "unit_cost",
    "total_cost",
]

ESTIMATE_COLUMNS = [
    "estimate_id",
    "estimate_number",
    "work_status",
    "customer_id",
    "customer_name",
    "customer_company",
    "customer_email",
    "customer_mobile",
    "street",
    "street_line_2",
    "city",
    "state",
    "zip",
    "scheduled_start",
    "scheduled_end",
    "on_my_way_at",
    "started_at",
    "completed_at",
    "created_at",
    "updated_at",
    "assigned_employees",
    "assigned_employee_ids",
    "lead_source",
    "job_type",
    "business_unit",
    "option_count",
]

# One row per estimate option. option_id ("est_…") is what a job's
# original_estimate_id points at.
ESTIMATE_OPTION_COLUMNS = [
    "estimate_id",
    "estimate_number",
    "option_id",
    "option_number",
    "name",
    "total_amount",
    "approval_status",
    "approval_status_updated_at",
    "status",
    "tags",
    "created_at",
    "updated_at",
]


class AuthError(SessionError):
    """A credential was rejected; stop the whole run."""


class RequestError(SessionError):
    """One request failed for good; the job can be retried on a later run."""


class Throttle:
    """Keep at least `interval` seconds between the starts of two requests."""

    def __init__(self, interval: float, clock=time.monotonic, sleep=time.sleep):
        self.interval = max(0.0, interval)
        self.clock = clock
        self.sleep = sleep
        self._last: float | None = None

    def wait(self) -> None:
        if self._last is not None:
            remaining = self._last + self.interval - self.clock()
            if remaining > 0:
                self.sleep(remaining)
        self._last = self.clock()


class Http:
    """Keep-alive JSON GETs with throttling and retries."""

    def __init__(self, throttle: Throttle, timeout: float = 30, sleep=time.sleep, verbose: bool = False):
        self.throttle = throttle
        self.timeout = timeout
        self.sleep = sleep
        self.verbose = verbose
        self._connections: dict[tuple[str, str, int], http.client.HTTPConnection] = {}

    def get_json(self, url: str, headers: dict[str, str], secrets: tuple[str, ...] = ()) -> object:
        rate_limited = 0
        server_failures = 0
        while True:
            self.throttle.wait()
            try:
                status, response_headers, body = self._get(url, headers)
            except (http.client.HTTPException, TimeoutError, OSError) as err:
                server_failures += 1
                if server_failures > MAX_SERVER_RETRIES:
                    raise RequestError(f"Could not reach {_host(url)} ({err.__class__.__name__}: {err}).") from err
                self._backoff(server_failures, f"connection error ({err.__class__.__name__})")
                continue

            if 200 <= status < 300:
                if not body.strip():
                    return {}
                try:
                    return json.loads(body)
                except json.JSONDecodeError as err:
                    raise RequestError(f"{_path(url)} returned a body that is not JSON.") from err
            if status == 401:
                raise AuthError(f"{_path(url)} returned HTTP 401.")
            if status == 429:
                rate_limited += 1
                if rate_limited > MAX_RATE_LIMIT_RETRIES:
                    raise RequestError(f"{_path(url)} stayed rate-limited after {MAX_RATE_LIMIT_RETRIES} retries.")
                wait = _retry_after(response_headers.get("Retry-After"))
                note(f"  rate-limited; waiting {wait:g}s")
                self.sleep(wait)
                continue
            if status >= 500:
                server_failures += 1
                if server_failures > MAX_SERVER_RETRIES:
                    raise RequestError(f"{_path(url)} returned HTTP {status}.")
                self._backoff(server_failures, f"HTTP {status}")
                continue
            detail = truncate(redact(body.decode("utf-8", errors="replace"), *secrets), 200)
            raise RequestError(f"{_path(url)} returned HTTP {status}." + (f" {detail}" if detail else ""))

    def close(self) -> None:
        for connection in self._connections.values():
            connection.close()
        self._connections.clear()

    def _backoff(self, attempt: int, reason: str) -> None:
        wait = 2.0**attempt
        note(f"  {reason}; retrying in {wait:g}s")
        self.sleep(wait)

    def _get(self, url: str, headers: dict[str, str]):
        parsed = urllib.parse.urlsplit(url)
        key = (parsed.scheme, parsed.hostname or "", parsed.port or (443 if parsed.scheme == "https" else 80))
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        if self.verbose:
            note(f"GET {path}")
        connection = self._connections.get(key)
        if connection is None:
            if parsed.scheme == "https":
                connection = http.client.HTTPSConnection(
                    key[1], key[2], timeout=self.timeout, context=ssl.create_default_context()
                )
            else:
                connection = http.client.HTTPConnection(key[1], key[2], timeout=self.timeout)
            self._connections[key] = connection
        try:
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            body = response.read()
        except BaseException:
            connection.close()
            self._connections.pop(key, None)
            raise
        if response.will_close:
            connection.close()
            self._connections.pop(key, None)
        return response.status, response.headers, body


class Housecall:
    def __init__(
        self,
        http: Http,
        api_key: str,
        cookie: str,
        public_base: str = PUBLIC_BASE,
        private_base: str = PRIVATE_BASE,
    ):
        self.http = http
        self.api_key = api_key
        self.cookie = cookie
        self.public_base = public_base.rstrip("/")
        self.private_base = private_base.rstrip("/")

    def company(self) -> dict:
        body = self._public("/company")
        return body if isinstance(body, dict) else {}

    def jobs(self):
        """Yield every job, page by page."""
        return self._paginate("jobs")

    def estimates(self):
        """Yield every estimate (with its options), page by page."""
        return self._paginate("estimates")

    def _paginate(self, resource: str):
        page = 1
        while True:
            query = urllib.parse.urlencode({"page": page, "page_size": JOBS_PAGE_SIZE})
            body = self._public(f"/{resource}?{query}")
            if not isinstance(body, dict):
                raise RequestError(f"The {resource} response is not an object.")
            records = body.get(resource)
            if records is None:
                records = body.get("data")
            if not isinstance(records, list):
                raise RequestError(f"The {resource} response has no {resource} list.")
            total_pages = body.get("total_pages")
            if not isinstance(total_pages, int) and isinstance(body.get("meta"), dict):
                total_pages = body["meta"].get("total_pages")
            note(f"{resource.capitalize()} page {page}" + (f" of {total_pages}" if isinstance(total_pages, int) else ""))
            yield from (record for record in records if isinstance(record, dict))
            if not records:
                return
            if isinstance(total_pages, int):
                if page >= total_pages:
                    return
            elif len(records) < JOBS_PAGE_SIZE:
                return
            page += 1

    def materials(self, job_id: str) -> list[dict]:
        pairs = [("job_uuid", job_id)] + [("expand[]", name) for name in MATERIAL_EXPAND]
        return _list_data(self._private(f"/alpha/job_costing/job_input_materials?{urllib.parse.urlencode(pairs)}"))

    def miscellaneous_items(self, job_id: str) -> list[dict]:
        return _list_data(self._private(f"/alpha/jobs/{urllib.parse.quote(job_id, safe='')}/miscellaneous_items"))

    def _public(self, path: str) -> object:
        headers = {
            "Authorization": f"Token {self.api_key}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        try:
            return self.http.get_json(f"{self.public_base}{path}", headers, (self.api_key,))
        except AuthError as err:
            raise AuthError(f"{err} The API key was rejected.") from err

    def _private(self, path: str) -> object:
        headers = {
            "Cookie": f"{COOKIE_NAME}={self.cookie}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        try:
            return self.http.get_json(f"{self.private_base}{path}", headers, (self.cookie,))
        except AuthError as err:
            raise AuthError(
                f"{err} The session cookie was rejected or has expired. "
                "Copy a fresh one and rerun; finished jobs are kept."
            ) from err


def _list_data(body: object) -> list[dict]:
    if not isinstance(body, dict) or not isinstance(body.get("data"), list):
        raise RequestError("The response has no data list.")
    return [row for row in body["data"] if isinstance(row, dict)]


def _retry_after(value: str | None) -> float:
    try:
        return max(1.0, float(value)) if value else DEFAULT_RETRY_AFTER
    except ValueError:
        return DEFAULT_RETRY_AFTER


def _host(url: str) -> str:
    return urllib.parse.urlsplit(url).hostname or url


def _path(url: str) -> str:
    return urllib.parse.urlsplit(url).path


# --- CSV rows ----------------------------------------------------------------


def dollars(cents) -> str:
    if cents is None or cents == "":
        return ""
    try:
        return f"{Decimal(str(cents)) / 100:.2f}"
    except InvalidOperation:
        return ""


def decimal_or_none(value) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def total_dollars(quantity: Decimal | None, unit_cost_cents) -> str:
    unit = decimal_or_none(unit_cost_cents)
    if quantity is None or unit is None:
        return ""
    return f"{quantity * unit / 100:.2f}"


def expanded(value) -> tuple[str, str]:
    """Name and uuid of an expanded relation: {"data": {...}}, a bare object, or a string."""
    if isinstance(value, dict):
        record = value.get("data") if isinstance(value.get("data"), dict) else value
        return str(record.get("name") or ""), str(record.get("uuid") or record.get("id") or "")
    if isinstance(value, str):
        return value, ""
    return "", ""


def _get(record, *keys):
    for key in keys:
        if not isinstance(record, dict):
            return ""
        record = record.get(key)
    return "" if record is None else record


def _join(values) -> str:
    return "; ".join(str(value) for value in values if value not in (None, ""))


def _full_name(person: dict) -> str:
    return " ".join(str(part) for part in (person.get("first_name"), person.get("last_name")) if part)


def job_row(job: dict) -> dict:
    customer = job.get("customer") if isinstance(job.get("customer"), dict) else {}
    employees = [employee for employee in job.get("assigned_employees") or [] if isinstance(employee, dict)]
    return {
        "job_id": job.get("id", ""),
        "invoice_number": _get(job, "invoice_number"),
        "description": _get(job, "description"),
        "work_status": _get(job, "work_status"),
        "customer_id": _get(customer, "id"),
        "customer_name": _full_name(customer),
        "customer_company": _get(customer, "company"),
        "customer_email": _get(customer, "email"),
        "customer_mobile": _get(customer, "mobile_number"),
        "street": _get(job, "address", "street"),
        "street_line_2": _get(job, "address", "street_line_2"),
        "city": _get(job, "address", "city"),
        "state": _get(job, "address", "state"),
        "zip": _get(job, "address", "zip"),
        "scheduled_start": _get(job, "schedule", "scheduled_start"),
        "scheduled_end": _get(job, "schedule", "scheduled_end"),
        "on_my_way_at": _get(job, "work_timestamps", "on_my_way_at"),
        "started_at": _get(job, "work_timestamps", "started_at"),
        "completed_at": _get(job, "work_timestamps", "completed_at"),
        "created_at": _get(job, "created_at"),
        "updated_at": _get(job, "updated_at"),
        "canceled_at": _get(job, "canceled_at"),
        "deleted_at": _get(job, "deleted_at"),
        "subtotal": dollars(job.get("subtotal")),
        "total_amount": dollars(job.get("total_amount")),
        "outstanding_balance": dollars(job.get("outstanding_balance")),
        "assigned_employees": _join(_full_name(e) for e in employees),
        "assigned_employee_ids": _join(e.get("id") for e in employees),
        "tags": _join(job.get("tags") or []),
        "lead_source": _get(job, "lead_source"),
        "job_type": _get(job, "job_fields", "job_type", "name"),
        "business_unit": _get(job, "job_fields", "business_unit", "name"),
        "original_estimate_id": _get(job, "original_estimate_id"),
        "recurrence_rule": _get(job, "recurrence_rule"),
    }


def material_row(job_id: str, invoice_number: str, material: dict) -> dict:
    vendor, vendor_uuid = expanded(material.get("material_vendor"))
    status, status_uuid = expanded(material.get("material_purchase_status"))
    source, source_uuid = expanded(material.get("material_source"))
    quantity = decimal_or_none(material.get("quantity"))
    return {
        "job_id": job_id,
        "invoice_number": invoice_number,
        "material_uuid": _get(material, "uuid"),
        "name": _get(material, "name"),
        "part_number": _get(material, "part_number"),
        "description": _get(material, "description"),
        "quantity": "" if quantity is None else str(quantity),
        "unit_of_measure": _get(material, "unit_of_measure"),
        "unit_cost": dollars(material.get("unit_cost")),
        "total_cost": total_dollars(quantity, material.get("unit_cost")),
        "vendor": vendor,
        "vendor_uuid": vendor_uuid,
        "purchase_status": status,
        "purchase_status_uuid": status_uuid,
        "material_source": source,
        "material_source_uuid": source_uuid,
        "pricebook_material_uuid": _get(material, "pricebook_material_uuid"),
    }


def misc_row(job_id: str, invoice_number: str, item: dict) -> dict:
    hundredths = item.get("qty_in_hundredths")
    if isinstance(hundredths, int):
        quantity = Decimal(hundredths) / 100
    else:
        quantity = decimal_or_none(item.get("quantity"))
    return {
        "job_id": job_id,
        "invoice_number": invoice_number,
        "item_uuid": _get(item, "uuid"),
        "name": _get(item, "name"),
        "description": _get(item, "description"),
        "quantity": "" if quantity is None else f"{quantity.normalize():f}",
        "unit_cost": dollars(item.get("unit_cost")),
        "total_cost": total_dollars(quantity, item.get("unit_cost")),
    }


def _people(record: dict) -> list[dict]:
    return [person for person in record.get("assigned_employees") or [] if isinstance(person, dict)]


def _options(estimate: dict) -> list[dict]:
    return [option for option in estimate.get("options") or [] if isinstance(option, dict)]


def estimate_row(estimate: dict) -> dict:
    customer = estimate.get("customer") if isinstance(estimate.get("customer"), dict) else {}
    employees = _people(estimate)
    return {
        "estimate_id": estimate.get("id", ""),
        "estimate_number": _get(estimate, "estimate_number"),
        "work_status": _get(estimate, "work_status"),
        "customer_id": _get(customer, "id"),
        "customer_name": _full_name(customer),
        "customer_company": _get(customer, "company"),
        "customer_email": _get(customer, "email"),
        "customer_mobile": _get(customer, "mobile_number"),
        "street": _get(estimate, "address", "street"),
        "street_line_2": _get(estimate, "address", "street_line_2"),
        "city": _get(estimate, "address", "city"),
        "state": _get(estimate, "address", "state"),
        "zip": _get(estimate, "address", "zip"),
        "scheduled_start": _get(estimate, "schedule", "scheduled_start"),
        "scheduled_end": _get(estimate, "schedule", "scheduled_end"),
        "on_my_way_at": _get(estimate, "work_timestamps", "on_my_way_at"),
        "started_at": _get(estimate, "work_timestamps", "started_at"),
        "completed_at": _get(estimate, "work_timestamps", "completed_at"),
        "created_at": _get(estimate, "created_at"),
        "updated_at": _get(estimate, "updated_at"),
        "assigned_employees": _join(_full_name(e) for e in employees),
        "assigned_employee_ids": _join(e.get("id") for e in employees),
        "lead_source": _get(estimate, "lead_source"),
        "job_type": _get(estimate, "estimate_fields", "job_type", "name"),
        "business_unit": _get(estimate, "estimate_fields", "business_unit", "name"),
        "option_count": len(_options(estimate)),
    }


def estimate_option_rows(estimate: dict) -> list[dict]:
    return [
        {
            "estimate_id": estimate.get("id", ""),
            "estimate_number": _get(estimate, "estimate_number"),
            "option_id": _get(option, "id"),
            "option_number": _get(option, "option_number"),
            "name": _get(option, "name"),
            "total_amount": dollars(option.get("total_amount")),
            "approval_status": _get(option, "approval_status"),
            "approval_status_updated_at": _get(option, "approval_status_updated_at"),
            "status": _get(option, "status"),
            "tags": _join(option.get("tags") or []),
            "created_at": _get(option, "created_at"),
            "updated_at": _get(option, "updated_at"),
        }
        for option in _options(estimate)
    ]


def write_csv(path: Path, columns: list[str], rows) -> int:
    count = 0
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
            count += 1
    tmp.replace(path)
    return count


# --- Progress ----------------------------------------------------------------


def load_progress(path: Path) -> dict[str, dict]:
    done: dict[str, dict] = {}
    if not path.exists():
        return done
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue  # a line cut short by an interrupted write
            if isinstance(record, dict) and isinstance(record.get("job_id"), str):
                done[record["job_id"]] = record
    return done


# --- Run ---------------------------------------------------------------------


def export(client: Housecall, out_dir: Path, fresh: bool = False, limit: int | None = None) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    progress_path = out_dir / "costs.jsonl"
    if fresh and progress_path.exists():
        progress_path.unlink()

    company = client.company()
    name = company.get("name") or company.get("business_name") or "your company"
    say(f"Company: {name} ({company.get('id', 'unknown id')})")

    jobs = list(client.jobs())
    if limit is not None:
        jobs = jobs[:limit]
    (out_dir / "jobs.json").write_text(json.dumps(jobs), encoding="utf-8")
    count = write_csv(out_dir / "jobs.csv", JOB_COLUMNS, (job_row(job) for job in jobs))
    say(f"Wrote {count} jobs to {out_dir / 'jobs.csv'}")

    estimates = list(client.estimates())
    (out_dir / "estimates.json").write_text(json.dumps(estimates), encoding="utf-8")
    count = write_csv(out_dir / "estimates.csv", ESTIMATE_COLUMNS, (estimate_row(e) for e in estimates))
    options = write_csv(
        out_dir / "estimate_options.csv",
        ESTIMATE_OPTION_COLUMNS,
        (row for e in estimates for row in estimate_option_rows(e)),
    )
    say(f"Wrote {count} estimates and {options} estimate options to {out_dir / 'estimates.csv'}")

    done = load_progress(progress_path)
    pending = [job for job in jobs if job.get("id") and job["id"] not in done]
    if done:
        say(f"Resuming: {len(jobs) - len(pending)} jobs already fetched, {len(pending)} to go.")

    failures: list[tuple[str, str]] = []
    with progress_path.open("a", encoding="utf-8") as progress:
        for index, job in enumerate(pending, start=1):
            job_id = job["id"]
            try:
                materials = client.materials(job_id)
                items = client.miscellaneous_items(job_id)
            except AuthError:
                raise
            except RequestError as err:
                failures.append((job_id, str(err)))
                note(f"[{index}/{len(pending)}] {job_id} failed: {err}")
                continue
            record = {"job_id": job_id, "materials": materials, "miscellaneous_items": items}
            progress.write(json.dumps(record) + "\n")
            progress.flush()
            done[job_id] = record
            note(f"[{index}/{len(pending)}] {job_id}: {len(materials)} materials, {len(items)} misc")

    invoice_numbers = {job.get("id"): str(job.get("invoice_number") or "") for job in jobs}
    ordered = [done[job["id"]] for job in jobs if job.get("id") in done]
    materials_count = write_csv(
        out_dir / "materials.csv",
        MATERIAL_COLUMNS,
        (
            material_row(record["job_id"], invoice_numbers[record["job_id"]], material)
            for record in ordered
            for material in record["materials"]
        ),
    )
    misc_count = write_csv(
        out_dir / "miscellaneous_items.csv",
        MISC_COLUMNS,
        (
            misc_row(record["job_id"], invoice_numbers[record["job_id"]], item)
            for record in ordered
            for item in record["miscellaneous_items"]
        ),
    )
    say(f"Wrote {materials_count} materials to {out_dir / 'materials.csv'}")
    say(f"Wrote {misc_count} miscellaneous items to {out_dir / 'miscellaneous_items.csv'}")

    if failures:
        say("")
        say(f"{len(failures)} jobs failed and are not in the cost CSVs. Rerun to retry them:")
        for job_id, message in failures:
            say(f"  {job_id}: {message}")
        return 1
    return 0


def read_credential(file: Path | None, env_name: str, noun: str, normalize) -> str:
    if file is not None:
        return normalize(read_secret_file(file.expanduser()))
    env = os.environ.get(env_name, "")
    if env.strip():
        return normalize(env)
    if not sys.stdin.isatty():
        raise InputError(f"Set {env_name} or pass the --{noun.replace(' ', '-')}-file option.")
    return normalize(prompt_hidden(noun))


def say(text: str = "") -> None:
    print(text, flush=True)


def note(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export every Housecall Pro job and its materials and miscellaneous items to CSV.",
        epilog=(
            f"Credentials also come from HCP_API_KEY and HCP_SESSION_COOKIE (the {COOKIE_NAME} "
            "value from your own signed-in browser), or a hidden prompt."
        ),
    )
    parser.add_argument("--api-key-file", type=Path, help="File containing your API key")
    parser.add_argument("--session-cookie-file", type=Path, help="File containing your session cookie value")
    parser.add_argument("--out", type=Path, default=Path("exports"), help="Output directory (default: exports)")
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY,
        help=f"Minimum seconds between requests (default: {DEFAULT_DELAY})",
    )
    parser.add_argument("--fresh", action="store_true", help="Ignore saved progress and fetch every job again")
    parser.add_argument("--limit", type=int, help="Only export the first N jobs (for a trial run)")
    parser.add_argument("--verbose", action="store_true", help="Print every request path")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    http = Http(Throttle(args.delay), verbose=args.verbose)
    try:
        api_key = read_credential(args.api_key_file, "HCP_API_KEY", "api key", normalize_api_key)
        cookie = read_credential(args.session_cookie_file, "HCP_SESSION_COOKIE", "session cookie", normalize_cookie)
        return export(Housecall(http, api_key, cookie), args.out, fresh=args.fresh, limit=args.limit)
    except KeyboardInterrupt:
        say("\nStopped. Rerun to pick up where this left off.")
        return 130
    except SessionError as err:
        note("")
        note(str(err))
        return 1
    finally:
        http.close()


if __name__ == "__main__":
    sys.exit(main())
