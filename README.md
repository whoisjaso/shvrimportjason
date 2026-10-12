# Housecall Pro private API session

Mint a browser session cookie for one franchisee organization. The cookie calls the private `/alpha/` API that the Housecall Pro web app uses.

Python 3.9 or newer is enough. The script uses the standard library only.

```bash
python3 hcp_session.py
```

## What you need

1. A franchisor login that can switch to the top-level account.
2. The franchisee's API key from Integrations settings.

The franchisor cookie lasts about 14 days. Sign in at the top-level account and copy a new one when it expires.

## Walkthrough

### 1. Franchisor session

Sign in at [pro.housecallpro.com](https://pro.housecallpro.com) and switch to the top-level account with the location switcher at the top left.

In Developer Tools, open the Network tab and select a request whose URL contains `https://pro.housecallpro.com/alpha/`. Copy the value of `_housecall-web_session_with_domain` from the response `Set-Cookie` header. If that response has no `Set-Cookie` header, copy the same cookie from the request `Cookie` header.

Paste the value on its own. Leave off the cookie name, `Path`, `Domain`, `Expires`, and `HttpOnly`. The script also accepts a full `Cookie` or `Set-Cookie` line and pulls the value out.

You can paste it (input stays hidden), read it from the clipboard, or read it from a file. After the exchange succeeds, the script can save it to `~/.config/hcp-private-api/franchisor-session.json` (mode `0600`) so the next run can reuse it.

### 2. Franchisee API key

Paste the owner API key. The script calls:

```http
GET https://api.housecallpro.com/company
Authorization: Token <api key>
```

It prints the company name and organization ID and asks you to confirm. For T1P Richmond that ID is `70e6c270-ae4d-4ffc-ade9-91c71ee721ee`.

If you already know the organization UUID, choose "I already have the organization ID", or pass `--org-id` / `HCP_ORG_ID`. When an API key is also set, that UUID has to match `/company`.

### 3. Franchisee session

The script posts the organization ID with the franchisor cookie:

```http
POST https://pro.housecallpro.com/alpha/franchisee_sessions
Cookie: _housecall-web_session_with_domain=<franchisor cookie>
Content-Type: application/json

{"organization_id": "<organization UUID>"}
```

The response body is empty. The script reads `_housecall-web_session_with_domain` from the response `Set-Cookie` header and prints that value. On a Mac it also copies the value to the clipboard.

Store the value on its own. Send it as one header:

```http
Cookie: _housecall-web_session_with_domain=<franchisee cookie>
```

You can then mint a cookie for another organization with the same franchisor session.

## Using the cookie

Send that header on requests to `https://pro.housecallpro.com` whose path contains `/alpha/`.

| Purpose | Request |
| --- | --- |
| Job input materials | `GET /alpha/job_costing/job_input_materials?job_uuid=job_…` |
| Miscellaneous items (labor costing) | `GET /alpha/jobs/job_…/miscellaneous_items` |
| Pricebook material search | `GET /alpha/pricebook/materials/search?q=…` |

## Repeat a run without prompts

Prefer environment variables or files so the secrets stay out of shell history.

```bash
export HCP_FRANCHISOR_COOKIE="$(cat ~/.config/hcp-private-api/franchisor-session.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["cookie"])')"
export HCP_API_KEY="$(cat franchisee.key)"

python3 hcp_session.py --yes --no-clipboard --out cookies/org.cookie
```

| Input | Flag | Environment variable |
| --- | --- | --- |
| Franchisor cookie | `--franchisor-cookie-file` | `HCP_FRANCHISOR_COOKIE` |
| Franchisee API key | `--api-key-file` | `HCP_API_KEY` |
| Organization UUID | `--org-id` | `HCP_ORG_ID` |

`--yes` skips confirmation. `--out` writes the franchisee cookie value to a file created as mode `0600`. `--no-clipboard` leaves the clipboard alone. `--no-save-franchisor` skips the offer to store the franchisor cookie. `--verbose` prints request paths and status codes.

`python3 hcp_session.py --help` lists the same flags.

## Tests

```bash
python3 -m unittest test_hcp_session.py
```

## Secrets

Cookie files and API keys stay out of git. `cookies/`, `*.cookie`, and `.env` are ignored. The saved franchisor session lives in your home directory, not in this repo.
