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

## Export jobs and job costs to CSV

`hcp_export.py` pulls every job from the public API, then each job's costing materials and miscellaneous items from the private API. It needs no franchisor session: use your own API key and the `_housecall-web_session_with_domain` value from your own signed-in browser (copy it the same way as in step 1, without switching accounts).

```bash
python3 hcp_export.py --api-key-file ~/.config/hcp-private-api/api.key \
  --session-cookie-file ~/.config/hcp-private-api/session.cookie
```

`HCP_API_KEY` and `HCP_SESSION_COOKIE` work too; with neither, the script prompts with hidden input.

It writes these files to `exports/` (`--out` to change):

| File | Contents |
| --- | --- |
| `jobs.csv` | One row per job: `job_id`, invoice number, status, customer, address, schedule and work times, money in dollars, employees, tags, job type |
| `materials.csv` | One row per job input material, with `job_id` and `invoice_number` |
| `miscellaneous_items.csv` | One row per miscellaneous item, with `job_id` and `invoice_number` |
| `estimates.csv` | One row per estimate (`estimate_id` is `csr_…`) |
| `estimate_options.csv` | One row per estimate option; `option_id` (`est_…`) matches a job's `original_estimate_id` |
| `jobs.json`, `estimates.json` | The raw jobs and estimates from the public API |
| `costs.jsonl` | The raw private API responses, one job per line |

Requests start at least `--delay` seconds apart (default 0.1). Each job takes two requests. A `429` waits for `Retry-After`; a `5xx` or dropped connection retries with exponential backoff. A job whose costs still fail is left out of the cost CSVs and listed at the end.

`costs.jsonl` doubles as progress. Rerunning into the same directory refetches the job list but only the job costs it doesn't have yet, so an expired cookie or Ctrl-C loses nothing. `--fresh` starts over; `--limit N` exports only the first N jobs for a trial run.

## Chrome extension

`extension/` is **SHVR Data Export**, a Chrome extension (Chrome and Edge, Mac and Windows) that downloads a company's records from the field-service software they use today so they can bring them to SHVR. It supports Housecall Pro and ServiceTitan, and new platforms plug in as another client and exporter beside those two. Users never copy a cookie: the extension uses the browser's own signed-in session. The page uses the SHVR look (shvr.app): its wordmark, palette, square corners, Plus Jakarta Sans and Inter (self-hosted in `extension/fonts/`).

Clicking the toolbar icon opens a three-step page: API key, Housecall Pro sign-in, Export. The export runs in the service worker, so it keeps going while the tab is in the background. It spaces requests 0.1s apart (`DEFAULT_DELAY_MS` in `extension/lib/hcp.js`) and backs off on `429` and `5xx`, like `hcp_export.py`. Progress is kept per job in `chrome.storage.local`, so a closed tab or restarted browser resumes where it stopped. The result is one zip in Downloads holding `jobs.csv`, `materials.csv`, `miscellaneous_items.csv`, `estimates.csv` and `estimate_options.csv`, with the same columns as `hcp_export.py`. The CSVs start with a byte-order mark so Excel shows accents and dashes correctly.

The page starts by asking which software the user has. Choosing **ServiceTitan** replaces the first two steps with a single sign-in step. ServiceTitan needs no API key. The extension finds the signed-in account (the "tenant") from ServiceTitan's cookies; if there are several, the user picks one. It then pages through `POST https://<tenant>.eh.go.servicetitan.com/Search/<Entity>` for Job, Estimate, Customer, Invoice, Lead and Payment, with the body `{"filter":{"page":N},"criteriaString":"{}"}`. Every record is kept whole: `extension/lib/flatten.js` turns nested fields into dotted columns, so each search becomes its own CSV with every field ServiceTitan returned. Each page is saved as it arrives, so an interrupted run resumes at the next page. A search stops when a page is empty, when it reaches the reported total, or when a page brings no records it hasn't already seen.

ServiceTitan attachments come after the searches. Checked live on 2026-11-13: the attachment endpoints take an **estimate** id (a job id returns HTTP 500), so the exporter walks every estimate. `GET /app/api/fam/documentManagement/7/<estimateId>/documents?size=1000&startIndex=N` lists the estimate's job's documents and photos (`ownerType` 1 = job; page while `isLast` is false). `GET /app/api/fam/documentManagement/1/<estimateId>/measurements` lists measurement reports, which belong to the job's location (`ownerType` 2); each report has several files. Every file downloads from `GET /Attach/Job?name=<url-encoded filename or fileUrl>`. A file reached through several estimates is fetched once. Files go to IndexedDB (`extension/lib/blobs.js`) as they arrive; when the run finishes, the open page builds the zip from those Blobs (with ZIP64 for archives over 4 GB) and downloads it, because a service worker can't make a Blob URL. The zip holds `attachments/job <number>/documents/…` and `…/measurements/…`, and `attachments.csv` lists every file with its job, estimate, zip path, size, download status, and every field ServiceTitan returned (`info.*` columns). Jobs with no estimate get no attachments; on the test account that was 204 of 417 jobs.

| Path | Role |
| --- | --- |
| `extension/lib/hcp.js` | Housecall Pro client, plus the shared throttled requester (retries, signed-out detection, byte downloads) |
| `extension/lib/exporter.js` | Housecall Pro export run and zip assembly |
| `extension/lib/servicetitan.js`, `extension/lib/st-exporter.js` | ServiceTitan tenant detection, search and attachment client, and export run |
| `extension/lib/blobs.js` | IndexedDB store for downloaded attachment files |
| `extension/lib/rows.js`, `extension/lib/flatten.js`, `extension/lib/zip.js` | CSV rows, whole-record flattening, and a stored zip writer (Blob parts, ZIP64) |
| `extension/background.js` | Service worker: runs the export, saves the zip, opens the page |
| `extension/app.html`, `app.js`, `app.css` | The page users see |

Try it locally: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose `extension/`.

Ship it: bump `version` in `extension/manifest.json`, run `npm run package` to build `dist/shvr-data-export-<version>.zip`, and upload that to the Chrome Web Store as an unlisted item. `store/LISTING.md` has the listing text, permission justifications and data disclosures. `store/PRIVACY.md` is the privacy policy to host publicly. `store/*.png` are the listing screenshots.

## Tests

```bash
npm test
```

That runs the extension tests (`node --test tests/extension/*.test.mjs`) and the Python tests.

## Secrets

Cookie files and API keys stay out of git. `cookies/`, `*.cookie`, `*.key`, `exports/`, and `.env` are ignored. The saved franchisor session lives in your home directory, not in this repo.
