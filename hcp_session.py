#!/usr/bin/env python3
"""Mint a Housecall Pro private-API cookie for one franchisee organization.

    python3 hcp_session.py

You supply a franchisor browser session and the franchisee's API key.
The script reads that company's organization ID, exchanges it for a
franchisee session, and prints the cookie value.
"""

from __future__ import annotations

import argparse
import getpass
import http.client
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import textwrap
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

PUBLIC_BASE = "https://api.housecallpro.com"
PRIVATE_BASE = "https://pro.housecallpro.com"
COMPANY_PATH = "/company"
FRANCHISEE_SESSION_PATH = "/alpha/franchisee_sessions"
COOKIE_NAME = "_housecall-web_session_with_domain"
USER_AGENT = "hcp-session-setup/1.0"
FRANCHISOR_TTL = timedelta(days=14)
CONFIG_PATH = Path.home() / ".config" / "hcp-private-api" / "franchisor-session.json"

MIN_COOKIE_LENGTH = 8
MAX_COOKIE_LENGTH = 16384
MIN_API_KEY_LENGTH = 8
MAX_API_KEY_LENGTH = 512

ID_FIELDS = ("id", "uuid", "organization_id", "organization_uuid", "company_id")
NAME_FIELDS = ("name", "business_name", "company_name")
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
COOKIE_ATTRIBUTES = {
    "path",
    "domain",
    "expires",
    "max-age",
    "samesite",
    "secure",
    "httponly",
    "priority",
}

FRANCHISOR_HELP = """
Sign in to Housecall Pro as a user with franchisor-level access:
  https://pro.housecallpro.com

Switch to the top-level account with the location switcher at the top left.

Grab the session cookie from the browser:

  1. Open Developer Tools and choose the Network tab.
  2. Refresh the page.
  3. Select a request whose URL contains https://pro.housecallpro.com/alpha/
  4. In the response headers, find Set-Cookie.
  5. Copy the value of _housecall-web_session_with_domain.

If that response has no Set-Cookie header, copy the same cookie from the
request's Cookie header. Copy the value on its own. Leave the cookie name,
Path, Domain, Expires, and HttpOnly out of what you paste.

The franchisor cookie is good for 14 days from the time you copy it.
Sign in at the top-level account again when you need a fresh one.
""".strip("\n")

API_KEY_HELP = """
Copy the franchisee's Housecall Pro API key from Integrations settings.
The key is used to read that company's organization ID from
https://api.housecallpro.com/company.
""".strip("\n")


class SessionError(Exception):
    """A failure the person running the script can act on."""


class InputError(SessionError):
    """The pasted cookie, API key, or organization ID cannot be used."""


@dataclass(frozen=True)
class SessionCookie:
    value: str
    max_age: int | None = None
    expires: datetime | None = None


@dataclass(frozen=True)
class ExchangeResult:
    status: int
    cookie: SessionCookie


@dataclass(frozen=True)
class CompanyInfo:
    name: str
    organization_id: str
    id_field: str
    time_zone: str | None
    place: str | None
    root_franchisor_id: str | None
    franchisor_depth: int | None
    other_ids: dict[str, str]


@dataclass(frozen=True)
class SavedCookie:
    value: str
    saved_at: datetime | None

    def age(self, now: datetime | None = None) -> timedelta | None:
        if self.saved_at is None:
            return None
        current = now or datetime.now(timezone.utc)
        return current - self.saved_at

    def is_stale(self, now: datetime | None = None) -> bool:
        age = self.age(now)
        return age is None or age >= FRANCHISOR_TTL

    def describe(self, now: datetime | None = None) -> str:
        age = self.age(now)
        if age is None:
            return "saved at an unknown time, past the 14-day window"
        text = describe_age(age)
        if self.is_stale(now):
            return f"{text}, past the 14-day window"
        return text


def describe_age(delta: timedelta) -> str:
    seconds = int(delta.total_seconds())
    if seconds < 60:
        return "just saved"
    minutes_total = seconds // 60
    hours, minutes = divmod(minutes_total, 60)
    days, hours = divmod(hours, 24)
    if days:
        return f"{days} day{'s' if days != 1 else ''} old"
    if hours:
        return f"{hours} hour{'s' if hours != 1 else ''} old"
    return f"{minutes} minute{'s' if minutes != 1 else ''} old"


def lifetime_note(cookie: SessionCookie) -> str | None:
    if cookie.max_age is not None:
        if cookie.max_age <= 0:
            return "Housecall Pro marked this cookie as already expired."
        days = cookie.max_age / 86400
        if days >= 1:
            shown = int(days) if days == int(days) else round(days, 1)
            unit = "day" if shown == 1 else "days"
            return (
                f"Housecall Pro set Max-Age to {cookie.max_age} seconds "
                f"(about {shown} {unit})."
            )
        return f"Housecall Pro set Max-Age to {cookie.max_age} seconds."
    if cookie.expires is not None:
        stamp = cookie.expires.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        return f"Housecall Pro set Expires to {stamp}."
    return None


def looks_like_uuid(value: str) -> bool:
    return UUID_RE.fullmatch(value) is not None


def fingerprint(secret: str) -> str:
    if len(secret) <= 8:
        return f"{len(secret)} characters"
    return f"{len(secret)} characters, ending in {secret[-4:]}"


def strip_wrapping_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _reject_header_unsafe(value: str, label: str) -> None:
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise InputError(f"That {label} contains control characters.")
    try:
        value.encode("ascii")
    except UnicodeEncodeError as err:
        raise InputError(f"That {label} needs to be plain ASCII.") from err


def normalize_cookie(raw: str) -> str:
    """Accept a bare value, a Cookie header, or a Set-Cookie header."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise InputError("The cookie value is empty.")
    if "..." in text and COOKIE_NAME.lower() not in text.lower():
        raise InputError("That looks like a placeholder. Paste the real cookie value.")

    match = re.search(rf"(?i){re.escape(COOKIE_NAME)}=(.*)", text)
    if match:
        value = strip_wrapping_quotes(match.group(1).split(";", 1)[0].split("\n", 1)[0].strip())
        return _validate_cookie_value(value)

    lines = [line.strip() for line in text.split("\n") if line.strip()]
    if len(lines) != 1:
        raise InputError(
            f"Paste only the {COOKIE_NAME} value, or a header line that includes it."
        )
    if re.match(r"(?i)^(set-)?cookie\s*:", lines[0]):
        raise InputError(f"That header does not include {COOKIE_NAME}.")

    parts = [part.strip() for part in lines[0].split(";") if part.strip()]
    first = parts[0]
    attributes = parts[1:]
    if attributes:
        if not all(_is_cookie_attribute(part) for part in attributes):
            raise InputError(f"Could not find {COOKIE_NAME} in that text.")
        if "=" not in first:
            raise InputError(f"Could not find {COOKIE_NAME} in that text.")
        name, value = first.split("=", 1)
        if name.lower() != COOKIE_NAME.lower():
            raise InputError(
                f"That cookie is named {name}. Copy the value of {COOKIE_NAME}."
            )
        return _validate_cookie_value(strip_wrapping_quotes(value.strip()))

    # A bare session value may itself contain "=". Only treat "name=value"
    # as the wrong cookie when it is a single assignment with no attributes.
    if re.fullmatch(r"[A-Za-z0-9_]+=[^=]+", first):
        name = first.split("=", 1)[0]
        raise InputError(f"That cookie is named {name}. Copy the value of {COOKIE_NAME}.")
    return _validate_cookie_value(strip_wrapping_quotes(first.strip()))


def _is_cookie_attribute(part: str) -> bool:
    name = part.split("=", 1)[0].strip().lower()
    return name in COOKIE_ATTRIBUTES


def _validate_cookie_value(value: str) -> str:
    if not value:
        raise InputError("The cookie value is empty.")
    if "..." in value:
        raise InputError("That looks like a placeholder. Paste the real cookie value.")
    _reject_header_unsafe(value, "cookie value")
    if any(ch.isspace() for ch in value) or ";" in value:
        raise InputError(
            f"Copy only the {COOKIE_NAME} value, with no spaces or extra cookie text."
        )
    if len(value) < MIN_COOKIE_LENGTH:
        raise InputError("That cookie value looks too short.")
    if len(value) > MAX_COOKIE_LENGTH:
        raise InputError("That cookie value looks too long.")
    return value


def normalize_api_key(raw: str) -> str:
    text = strip_wrapping_quotes(raw.strip())
    text = re.sub(r"(?i)^authorization\s*:\s*", "", text).strip()
    text = re.sub(r"(?i)^(token|bearer)\s+", "", text).strip()
    text = re.sub(r"(?i)^token=", "", text).strip()
    text = strip_wrapping_quotes(text)
    if not text:
        raise InputError("The API key is empty.")
    _reject_header_unsafe(text, "API key")
    if any(ch.isspace() for ch in text):
        raise InputError("That API key contains spaces.")
    if len(text) < MIN_API_KEY_LENGTH:
        raise InputError("That API key looks too short.")
    if len(text) > MAX_API_KEY_LENGTH:
        raise InputError("That API key looks too long.")
    return text


def normalize_org_id(raw: str) -> str:
    text = raw.strip()
    if not text:
        raise InputError("The organization ID is empty.")
    _reject_header_unsafe(text, "organization ID")
    if any(ch.isspace() for ch in text):
        raise InputError("An organization ID cannot contain spaces.")
    if len(text) > 128:
        raise InputError("That organization ID is too long.")
    return text


def parse_set_cookie(header_value: str) -> tuple[str, str, int | None, datetime | None]:
    parts = [part.strip() for part in header_value.split(";") if part.strip()]
    if not parts or "=" not in parts[0]:
        return "", "", None, None
    name, value = parts[0].split("=", 1)
    max_age = None
    expires = None
    for attr in parts[1:]:
        key, sep, raw_val = attr.partition("=")
        key = key.strip().lower()
        if not sep:
            continue
        if key == "max-age":
            try:
                max_age = int(raw_val.strip())
            except ValueError:
                continue
        elif key == "expires":
            expires = _parse_expires(raw_val.strip())
    return name.strip(), strip_wrapping_quotes(value.strip()), max_age, expires


def _parse_expires(value: str) -> datetime | None:
    try:
        return parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


def iter_set_cookie(headers) -> list[str]:
    if headers is None:
        return []
    if isinstance(headers, (list, tuple)):
        return [str(item) for item in headers]
    getter = getattr(headers, "get_all", None)
    if callable(getter):
        values = getter("Set-Cookie")
        if values:
            return [str(item) for item in values]
    raw_headers = getattr(headers, "_headers", None)
    if isinstance(raw_headers, list):
        found = [str(value) for key, value in raw_headers if str(key).lower() == "set-cookie"]
        if found:
            return found
    items = getattr(headers, "items", None)
    if callable(items):
        return [str(value) for key, value in items() if str(key).lower() == "set-cookie"]
    return []


def session_from_set_cookie(headers) -> tuple[SessionCookie | None, list[str]]:
    """Return the last session cookie and every Set-Cookie name that arrived."""
    found = None
    names: list[str] = []
    for line in iter_set_cookie(headers):
        name, value, max_age, expires = parse_set_cookie(line)
        if name:
            names.append(name)
        if name.lower() == COOKIE_NAME.lower() and value:
            found = SessionCookie(value=value, max_age=max_age, expires=expires)
    return found, names


def company_record(payload: dict) -> dict:
    data = payload.get("data")
    outer_has_identity = any(key in payload for key in ("id", "name", "uuid", "business_name"))
    if isinstance(data, dict) and not outer_has_identity:
        if any(key in data for key in ("id", "name", "uuid", "business_name", "company_name")):
            return data
    return payload


def summarize_company(payload: dict) -> CompanyInfo:
    if not isinstance(payload, dict):
        raise SessionError("Housecall Pro returned a company response that is not an object.")
    record = company_record(payload)
    found: dict[str, str] = {}
    for field in ID_FIELDS:
        raw = record.get(field)
        if isinstance(raw, str) and raw.strip():
            found[field] = raw.strip()
    if not found:
        keys = ", ".join(sorted(str(key) for key in record)) or "(none)"
        raise SessionError(f"The company response had no organization ID. Keys: {keys}.")

    id_field = next(field for field in ID_FIELDS if field in found)
    organization_id = found[id_field]
    name = "Unnamed company"
    for field in NAME_FIELDS:
        raw = record.get(field)
        if isinstance(raw, str) and raw.strip():
            name = raw.strip()
            break

    time_zone = record.get("time_zone")
    if not isinstance(time_zone, str) or not time_zone.strip():
        time_zone = None
    else:
        time_zone = time_zone.strip()

    franchise = record.get("franchise_info")
    root = None
    depth = None
    if isinstance(franchise, dict):
        raw_root = franchise.get("root_franchisor_id")
        if isinstance(raw_root, str) and raw_root.strip():
            root = raw_root.strip()
        raw_depth = franchise.get("franchisor_depth")
        if isinstance(raw_depth, int):
            depth = raw_depth

    others = {field: value for field, value in found.items() if value != organization_id}
    return CompanyInfo(
        name=name,
        organization_id=organization_id,
        id_field=id_field,
        time_zone=time_zone,
        place=_place_of(record),
        root_franchisor_id=root,
        franchisor_depth=depth,
        other_ids=others,
    )


def _place_of(record: dict) -> str | None:
    address = record.get("address")
    if not isinstance(address, dict):
        return None
    city = address.get("city") if isinstance(address.get("city"), str) else ""
    state = address.get("state") if isinstance(address.get("state"), str) else ""
    bits = [bit.strip() for bit in (city, state) if bit.strip()]
    return ", ".join(bits) or None


def select_organization_id(info: CompanyInfo, explicit: str | None) -> str:
    if explicit is None:
        return info.organization_id
    known = {info.organization_id, *info.other_ids.values()}
    if explicit not in known:
        raise SessionError(
            f"Organization ID {explicit} does not match /company "
            f"({info.id_field} {info.organization_id})."
        )
    return explicit


def redact(text: str, *secrets: str) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[redacted]")
    return redacted


def truncate(text: str, limit: int = 400) -> str:
    stripped = text.strip()
    if len(stripped) <= limit:
        return stripped
    return stripped[:limit] + "…"


class HousecallClient:
    def __init__(
        self,
        public_base: str = PUBLIC_BASE,
        private_base: str = PRIVATE_BASE,
        timeout: float = 30,
        verbose: bool = False,
    ):
        self.public_base = public_base.rstrip("/")
        self.private_base = private_base.rstrip("/")
        self.timeout = timeout
        self.verbose = verbose

    def get_company(self, api_key: str) -> dict:
        status, _headers, body = self._request(
            "GET",
            f"{self.public_base}{COMPANY_PATH}",
            {
                "Authorization": f"Token {api_key}",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        if status == 401:
            raise SessionError(
                "The API key was rejected. Copy it again from the franchisee's "
                "Integrations settings."
            )
        if status == 429:
            raise SessionError("Housecall Pro rate-limited the company lookup. Wait and run this again.")
        if not 200 <= status < 300:
            detail = truncate(redact(body.decode("utf-8", errors="replace"), api_key))
            message = f"The company lookup returned HTTP {status}."
            if detail:
                message = f"{message}\n{detail}"
            raise SessionError(message)
        return _parse_json_object(body, "company")

    def open_franchisee_session(self, franchisor_cookie: str, organization_id: str) -> ExchangeResult:
        payload = json.dumps({"organization_id": organization_id}).encode("ascii")
        status, headers, body = self._request(
            "POST",
            f"{self.private_base}{FRANCHISEE_SESSION_PATH}",
            {
                "Cookie": f"{COOKIE_NAME}={franchisor_cookie}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            body=payload,
        )
        cookie, names = session_from_set_cookie(headers)
        if cookie is not None and 200 <= status < 400:
            return ExchangeResult(status=status, cookie=cookie)
        raise SessionError(
            _exchange_failure(
                status,
                body.decode("utf-8", errors="replace"),
                names,
                franchisor_cookie,
                cookie.value if cookie else "",
            )
        )

    def _request(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None = None,
    ) -> tuple[int, http.client.HTTPMessage, bytes]:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise SessionError(f"Invalid URL {url}.")
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        if self.verbose:
            note(f"{method} {path}")
        try:
            if parsed.scheme == "https":
                connection = http.client.HTTPSConnection(
                    parsed.hostname,
                    parsed.port or 443,
                    timeout=self.timeout,
                    context=ssl.create_default_context(),
                )
            else:
                connection = http.client.HTTPConnection(
                    parsed.hostname,
                    parsed.port or 80,
                    timeout=self.timeout,
                )
            try:
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                payload = response.read()
                if self.verbose:
                    note(f"  -> {response.status}")
                return response.status, response.headers, payload
            finally:
                connection.close()
        except SessionError:
            raise
        except (http.client.HTTPException, TimeoutError, OSError) as err:
            raise SessionError(
                f"Could not reach {parsed.hostname} ({err.__class__.__name__}: {err})."
            ) from err


def _parse_json_object(body: bytes, label: str) -> dict:
    if not body.strip():
        raise SessionError(f"Housecall Pro returned an empty {label} response.")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as err:
        raise SessionError(f"Housecall Pro returned a {label} response that is not JSON.") from err
    if not isinstance(payload, dict):
        raise SessionError(f"Housecall Pro returned a {label} response that is not an object.")
    return payload


def _exchange_failure(
    status: int,
    body: str,
    names: list[str],
    *secrets: str,
) -> str:
    lines = [f"franchisee_sessions returned HTTP {status}."]
    if status in {401, 403}:
        lines.append(
            "The franchisor cookie was rejected, or this account cannot open that organization. "
            "Sign in at the top-level account and copy a fresh cookie."
        )
    elif status == 404:
        lines.append("That organization ID is not one this franchisor session can open.")
    elif status == 422:
        lines.append(
            "Housecall Pro rejected the organization ID. Confirm it belongs to a franchisee "
            "under this top-level account."
        )
    elif status == 429:
        lines.append("Housecall Pro rate-limited the session exchange. Wait and run this again.")
    listed = ", ".join(names) if names else "none"
    lines.append(f"Set-Cookie names: {listed}.")
    detail = truncate(redact(body, *secrets))
    if detail:
        lines.append(detail)
    return "\n".join(lines)


def load_saved_franchisor() -> SavedCookie | None:
    path = CONFIG_PATH
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        value = normalize_cookie(data["cookie"])
        raw_saved = data.get("saved_at")
        saved_at = _parse_saved_at(raw_saved) if isinstance(raw_saved, str) else None
    except (OSError, json.JSONDecodeError, KeyError, TypeError, InputError, ValueError) as err:
        note(f"Ignoring the saved franchisor cookie ({err}).")
        return None
    return SavedCookie(value, saved_at)


def _parse_saved_at(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def save_franchisor(cookie: str) -> Path:
    path = CONFIG_PATH
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        payload = json.dumps(
            {
                "cookie": cookie,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        _write_private(path, payload.encode("utf-8"))
    except OSError as err:
        raise SessionError(f"Could not save the franchisor cookie ({err}).") from err
    return path


def forget_saved_franchisor() -> None:
    try:
        CONFIG_PATH.unlink(missing_ok=True)
    except OSError as err:
        raise SessionError(f"Could not remove the saved franchisor cookie ({err}).") from err


def write_secret_file(path: Path, value: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_private(path, value.encode("ascii"))
    except OSError as err:
        raise SessionError(f"Could not write {path} ({err}).") from err


def _write_private(path: Path, payload: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, payload)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)


def read_secret_file(path: Path) -> str:
    try:
        if not path.is_file():
            raise InputError(f"No file at {path}.")
        if path.stat().st_size > 64 * 1024:
            raise InputError(f"{path} is too large.")
        return path.read_text(encoding="utf-8-sig")
    except OSError as err:
        raise InputError(f"Could not read {path} ({err}).") from err


def display_path(path: Path) -> str:
    try:
        return "~/" + str(path.relative_to(Path.home()))
    except ValueError:
        return str(path)


def clipboard_available() -> bool:
    return shutil.which("pbpaste") is not None and shutil.which("pbcopy") is not None


def read_clipboard() -> str:
    try:
        result = subprocess.run(
            ["pbpaste"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as err:
        raise InputError("Clipboard access is unavailable on this machine.") from err
    if result.returncode != 0:
        raise InputError("Could not read the clipboard.")
    return result.stdout


def copy_to_clipboard(value: str) -> bool:
    try:
        result = subprocess.run(["pbcopy"], input=value, text=True, check=False)
    except FileNotFoundError:
        return False
    return result.returncode == 0


def say(text: str = "") -> None:
    print(text, flush=True)


def note(text: str) -> None:
    print(text, file=sys.stderr, flush=True)


def emphasis(text: str) -> str:
    is_tty = getattr(sys.stdout, "isatty", None)
    if callable(is_tty) and is_tty():
        return f"\033[1m{text}\033[0m"
    return text


def confirm(prompt: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    answer = input(f"{prompt} [{hint}] ").strip().lower()
    if not answer:
        return default
    return answer in {"y", "yes"}


def menu(title: str, options: list[tuple[str, str]], default_key: str | None = None) -> str:
    say(title)
    for index, (key, label) in enumerate(options, start=1):
        suffix = " (default)" if key == default_key else ""
        say(f"  {index}) {label}{suffix}")
    keys = {key.lower(): key for key, _label in options}
    while True:
        raw = input("Choice: ").strip()
        if not raw and default_key is not None:
            return default_key
        if raw.isdigit():
            index = int(raw) - 1
            if 0 <= index < len(options):
                return options[index][0]
        if raw.lower() in keys:
            return keys[raw.lower()]
        say(f"Enter a number from 1 to {len(options)}.")


def prompt_hidden(noun: str) -> str:
    if not sys.stdin.isatty():
        raise SessionError(f"Pasting the {noun} needs a terminal.")
    return getpass.getpass(f"Paste the {noun}: ")


def read_secret_source(choice: str, noun: str) -> str:
    if choice == "clipboard":
        return read_clipboard()
    if choice == "paste":
        return prompt_hidden(noun)
    if choice == "file":
        entered = input("File path: ").strip()
        if not entered:
            raise InputError("Enter a file path.")
        return read_secret_file(Path(entered).expanduser())
    raise InputError(f"Unknown source {choice}.")


def secret_source_options() -> list[tuple[str, str]]:
    options: list[tuple[str, str]] = []
    if clipboard_available():
        options.append(("clipboard", "Read it from the clipboard"))
    options.append(("paste", "Paste it here (input stays hidden)"))
    options.append(("file", "Read it from a file"))
    return options


def print_banner() -> None:
    say("Housecall Pro private API")
    say("Franchisee session cookie")
    say("")
    say(
        textwrap.fill(
            "This walks through a franchisor browser session and a franchisee API key, "
            "then prints the cookie for that organization's private /alpha/ API.",
            width=72,
        )
    )
    say("")


def print_company(info: CompanyInfo) -> None:
    say("")
    say(f"Company:          {info.name}")
    say(f"Organization ID:  {info.organization_id}")
    say(f"ID field:         {info.id_field}")
    if info.place:
        say(f"Location:         {info.place}")
    if info.time_zone:
        say(f"Time zone:        {info.time_zone}")
    if info.root_franchisor_id:
        say(f"Franchisor root:  {info.root_franchisor_id}")
    if info.franchisor_depth is not None:
        say(f"Franchisor depth: {info.franchisor_depth}")
    for field, value in info.other_ids.items():
        say(f"Also {field}: {value}")
    if info.root_franchisor_id and info.root_franchisor_id == info.organization_id:
        say("")
        say("This ID is the franchisor root.")
        say("Use the franchisee's own API key when you want that location's cookie.")


def obtain_franchisor(args, tty: bool) -> tuple[str, bool]:
    """Return the franchisor cookie and whether to store it after a successful exchange."""
    if args.franchisor_cookie_file:
        value = normalize_cookie(read_secret_file(args.franchisor_cookie_file))
        say(
            f"Using the franchisor cookie from {display_path(args.franchisor_cookie_file)} "
            f"({fingerprint(value)})."
        )
        return value, False

    env = os.environ.get("HCP_FRANCHISOR_COOKIE", "")
    if env.strip():
        value = normalize_cookie(env)
        say(f"Using the franchisor cookie from HCP_FRANCHISOR_COOKIE ({fingerprint(value)}).")
        return value, False

    saved = load_saved_franchisor()
    if saved is not None and not saved.is_stale() and (args.yes or not tty):
        say(f"Using the saved franchisor cookie ({saved.describe()}).")
        return saved.value, False
    if not tty:
        raise SessionError(
            "Set HCP_FRANCHISOR_COOKIE or pass --franchisor-cookie-file. "
            "A terminal is required to paste the cookie."
        )

    say(emphasis("Step 1  ·  Franchisor session"))
    say("")
    say(FRANCHISOR_HELP)
    say("")
    return prompt_franchisor(saved, allow_save=not args.no_save_franchisor)


def prompt_franchisor(saved: SavedCookie | None, allow_save: bool) -> tuple[str, bool]:
    current = saved
    while True:
        options = secret_source_options()
        default = options[0][0]
        if current is not None:
            label = f"Reuse the saved franchisor cookie ({current.describe()})"
            options.insert(0, ("reuse", label))
            options.append(("forget", "Forget the saved franchisor cookie"))
            default = "reuse" if not current.is_stale() else options[1][0]
        choice = menu("How should I read the franchisor cookie?", options, default_key=default)
        if choice == "forget":
            forget_saved_franchisor()
            current = None
            say("Forgot the saved franchisor cookie.")
            say("")
            continue
        if choice == "reuse":
            if current is None:
                raise SessionError("There is no saved franchisor cookie to reuse.")
            return current.value, False
        try:
            value = normalize_cookie(read_secret_source(choice, "franchisor cookie"))
        except InputError as err:
            say(str(err))
            say("")
            continue
        say(f"Received a franchisor cookie ({fingerprint(value)}).")
        if not confirm("Use this franchisor cookie?"):
            continue
        wants_save = allow_save and confirm(
            "Save this franchisor cookie in your home directory after the exchange succeeds?",
            default=True,
        )
        return value, wants_save


def obtain_api_key(api_key_file: Path | None, use_env: bool, tty: bool) -> str | None:
    if api_key_file is not None:
        value = normalize_api_key(read_secret_file(api_key_file))
        say(f"Using the API key from {display_path(api_key_file)} ({fingerprint(value)}).")
        return value
    env = os.environ.get("HCP_API_KEY", "")
    if use_env and env.strip():
        value = normalize_api_key(env)
        say(f"Using the API key from HCP_API_KEY ({fingerprint(value)}).")
        return value
    if not tty:
        return None
    say("")
    say(emphasis("Step 2  ·  Franchisee API key"))
    say("")
    say(API_KEY_HELP)
    say("")
    options = secret_source_options()
    options.append(("org", "I already have the organization ID"))
    while True:
        choice = menu(
            "How should I read the franchisee API key?",
            options,
            default_key=options[0][0],
        )
        if choice == "org":
            return None
        try:
            value = normalize_api_key(read_secret_source(choice, "API key"))
        except InputError as err:
            say(str(err))
            say("")
            continue
        say(f"Received an API key ({fingerprint(value)}).")
        if confirm("Use this API key?"):
            return value


def prompt_org_id() -> str:
    while True:
        try:
            value = normalize_org_id(input("Organization ID: "))
        except InputError as err:
            say(str(err))
            continue
        if confirm(f"Use organization ID {value}?"):
            return value


def choose_among_ids(info: CompanyInfo, tty: bool, assume_yes: bool) -> str:
    if not info.other_ids:
        return info.organization_id
    if assume_yes or not tty:
        say(f"Using {info.id_field} ({info.organization_id}).")
        return info.organization_id
    options = [(info.id_field, f"{info.id_field}: {info.organization_id}")]
    for field, value in info.other_ids.items():
        options.append((field, f"{field}: {value}"))
    chosen = menu(
        "Which ID should be sent as organization_id?",
        options,
        default_key=info.id_field,
    )
    if chosen == info.id_field:
        return info.organization_id
    return info.other_ids[chosen]


def resolve_target(client: HousecallClient, owner: dict, tty: bool, assume_yes: bool) -> tuple[str, str]:
    while True:
        api_key = obtain_api_key(owner["api_key_file"], owner["use_env"], tty)
        org_arg = owner["org_id"]
        if api_key is None and org_arg is None:
            if not tty:
                raise SessionError("Set HCP_API_KEY or HCP_ORG_ID, or pass --api-key-file / --org-id.")
            org_arg = prompt_org_id()
        if api_key is None:
            if not looks_like_uuid(org_arg):
                say("That organization ID is not a UUID. franchisee_sessions expects a UUID.")
            prompt = f"Open a franchisee session for {org_arg}?"
            if assume_yes or confirm(prompt, default=looks_like_uuid(org_arg)):
                return org_arg, org_arg
            if assume_yes or not confirm("Try a different organization?", default=True):
                raise SessionError("Stopped before opening a session.")
            owner["api_key_file"] = None
            owner["org_id"] = None
            owner["use_env"] = False
            continue

        say("")
        say("Reading the company from the Housecall Pro API…")
        info = summarize_company(client.get_company(api_key))
        print_company(info)
        if org_arg is not None:
            org_id = select_organization_id(info, org_arg)
        else:
            org_id = choose_among_ids(info, tty, assume_yes)
        if not looks_like_uuid(org_id):
            say("")
            say("That organization ID is not a UUID. franchisee_sessions expects a UUID.")
        label = f"{info.name} ({org_id})"
        say("")
        if assume_yes or confirm(
            f"Open a franchisee session for {label}?",
            default=looks_like_uuid(org_id),
        ):
            return org_id, label
        if assume_yes or not confirm("Try a different API key?", default=True):
            raise SessionError("Stopped before opening a session.")
        owner["api_key_file"] = None
        owner["org_id"] = None
        owner["use_env"] = False


def present_cookie(
    result: ExchangeResult,
    org_id: str,
    label: str,
    franchisor_cookie: str,
    args,
    tty: bool,
) -> None:
    cookie = result.cookie
    say("")
    say(emphasis(f"Franchisee session for {label}"))
    if 300 <= result.status < 400:
        say(
            f"Housecall Pro responded {result.status} and set the franchisee cookie "
            "on that response."
        )
    else:
        say(f"Housecall Pro responded {result.status} and set the franchisee cookie.")
    note_text = lifetime_note(cookie)
    if note_text:
        say(note_text)
    if cookie.value == franchisor_cookie:
        say("")
        say("This value matches the franchisor cookie.")
        say("Housecall Pro may still be on the top-level account.")
        say("Confirm that account can open this franchisee, then run the exchange again.")
    say("")
    say(emphasis("Franchisee cookie value"))
    say("")
    say(cookie.value)
    say("")
    say("Request header")
    say("")
    say(f"Cookie: {COOKIE_NAME}={cookie.value}")
    say("")
    say("Store the value on its own. The header above is the line that includes the cookie name.")
    say("")
    say("Send that header on requests to https://pro.housecallpro.com that contain /alpha/.")
    say("Examples:")
    say("  GET /alpha/job_costing/job_input_materials?job_uuid=job_…")
    say("  GET /alpha/jobs/job_…/miscellaneous_items")
    say("  GET /alpha/pricebook/materials/search?q=…")

    if not args.no_clipboard:
        if copy_to_clipboard(cookie.value):
            say("")
            say("Copied the cookie value to the clipboard.")
        elif clipboard_available():
            say("")
            say("Could not copy the cookie value to the clipboard.")

    if args.out is not None:
        write_secret_file(args.out, cookie.value)
        say(f"Wrote the cookie value to {display_path(args.out)}.")
        args.out = None
        return
    if tty and not args.yes and confirm("Save this cookie value to a file?", default=False):
        default_path = Path("cookies") / f"{org_id}.cookie"
        entered = input(f"Path [{default_path}]: ").strip()
        path = Path(entered).expanduser() if entered else default_path
        write_secret_file(path, cookie.value)
        say(f"Wrote the cookie value to {display_path(path)}.")


def run(args) -> int:
    tty = sys.stdin.isatty()
    client = HousecallClient(verbose=args.verbose)
    print_banner()
    franchisor, save_franchisor_after = obtain_franchisor(args, tty)
    owner = {
        "api_key_file": args.api_key_file,
        "org_id": initial_org_id(args),
        "use_env": True,
    }
    success = False
    while True:
        try:
            org_id, label = resolve_target(client, owner, tty, args.yes or not tty)
            say("")
            say(emphasis("Step 3  ·  Franchisee session"))
            say("")
            say(f"Opening a franchisee session for {label}…")
            result = client.open_franchisee_session(franchisor, org_id)
            present_cookie(result, org_id, label, franchisor, args, tty)
            success = True
            if save_franchisor_after:
                path = save_franchisor(franchisor)
                say(f"Saved the franchisor cookie to {display_path(path)}.")
                save_franchisor_after = False
        except SessionError as err:
            note("")
            note(str(err))
            success = False
            if args.yes or not tty:
                return 1
            say("")
            if not confirm("Try again?", default=True):
                return 1
            owner["api_key_file"] = None
            owner["org_id"] = None
            owner["use_env"] = False
            continue
        if args.yes or not tty:
            return 0
        say("")
        if not confirm("Mint a cookie for another organization?", default=False):
            return 0 if success else 1
        owner["api_key_file"] = None
        owner["org_id"] = None
        owner["use_env"] = False


def initial_org_id(args) -> str | None:
    if args.org_id:
        return normalize_org_id(args.org_id)
    env = os.environ.get("HCP_ORG_ID", "").strip()
    if env:
        return normalize_org_id(env)
    return None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Mint a Housecall Pro private-API session cookie for one franchisee organization."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            f"""
            The franchisor cookie is the {COOKIE_NAME} value from a browser
            signed into the top-level account. It lasts about 14 days.

            Environment variables, when you already have the values:
              HCP_FRANCHISOR_COOKIE   franchisor session value
              HCP_API_KEY             franchisee API key
              HCP_ORG_ID              organization UUID, if you already know it

            Prefer those, or the --*-file options, so secrets stay out of shell history.
            """
        ).strip("\n"),
    )
    parser.add_argument(
        "--franchisor-cookie-file",
        type=Path,
        help="File containing the franchisor session cookie value",
    )
    parser.add_argument(
        "--api-key-file",
        type=Path,
        help="File containing the franchisee API key",
    )
    parser.add_argument(
        "--org-id",
        help="Organization UUID. When an API key is also set, it must match /company.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="Write the franchisee cookie value to this file (mode 0600)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip confirmation prompts",
    )
    parser.add_argument(
        "--no-clipboard",
        action="store_true",
        help="Leave the clipboard unchanged",
    )
    parser.add_argument(
        "--no-save-franchisor",
        action="store_true",
        help="Do not offer to save the franchisor cookie",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print request paths and status codes",
    )
    args = parser.parse_args(argv)
    if args.org_id:
        try:
            args.org_id = normalize_org_id(args.org_id)
        except InputError as err:
            parser.error(str(err))
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args)
    except KeyboardInterrupt:
        say("\nStopped.")
        return 130
    except EOFError:
        say("\nStopped.")
        return 1
    except SessionError as err:
        note("")
        note(str(err))
        return 1


if __name__ == "__main__":
    sys.exit(main())
