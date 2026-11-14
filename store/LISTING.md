# Chrome Web Store listing

Paste these into the developer dashboard at <https://chrome.google.com/webstore/devconsole> when you submit `dist/shvr-data-export-<version>.zip` (built with `npm run package`).

## Store listing tab

**Name** (from the manifest): SHVR Data Export

**Summary** (132 characters max):

> Download your jobs, estimates, customers and more from Housecall Pro or ServiceTitan as spreadsheets you can bring to SHVR.

**Description:**

> SHVR Data Export downloads the records from the software you use today and saves them as one zip file of spreadsheets you can open in Excel or Google Sheets.
>
> ServiceTitan
> Sign in to ServiceTitan in Chrome and choose ServiceTitan. No API key needed. You get one spreadsheet each for jobs, estimates, customers, invoices, leads and payments, with every field ServiceTitan provides. If you include attachments, each job's photos, documents and measurement reports come in a second zip file, with attachments.csv listing every file and the job it belongs to.
>
> Housecall Pro
> Sign in to Housecall Pro in Chrome. The extension uses your company's SHVR API key, or creates a read-only one for you (admins only; anyone else can paste a key instead). You get:
> • jobs.csv: every job with its invoice number, status, customer, address, dates, totals and assigned employees
> • materials.csv: every material on every job, with quantity, unit cost, total, vendor and purchase status
> • miscellaneous_items.csv: every miscellaneous cost on every job, such as subcontractor labor
> • estimates.csv and estimate_options.csv: every estimate and each of its options, with totals and approval status
> Material and miscellaneous rows carry the job ID and invoice number, so each one links back to its job.
>
> A progress bar shows how far along the export is. Requests are spaced out so the export doesn't overload either service, and an interrupted export picks up where it left off.
>
> Your data goes only between your browser and Housecall Pro or ServiceTitan. Nothing is sent to us or anyone else.
>
> Housecall Pro needs a plan with API access (MAX). This extension is not made by or affiliated with Housecall Pro or ServiceTitan.

**Category:** Productivity (Workflow & Planning)

**Language:** English

**Screenshots:** `store/screenshot-running.png` (1280×800). The store needs at least one and accepts up to five; a "done" screenshot would be a good second.

**Icon:** `extension/icons/icon-128.png`

## Privacy practices tab

**Single purpose:**

> Export the user's own records (jobs, estimates, customers, invoices, leads, payments, job costs and job attachments) from their field-service software to CSV spreadsheets and files in zip files.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `storage` | Remembers the user's API key and saves export progress so an interrupted export can resume. |
| `unlimitedStorage` | Export progress for large accounts (thousands of jobs) can exceed the default local storage quota. |
| `downloads` | Saves the finished zip of spreadsheets to the user's Downloads folder and shows it in the folder on request. |
| Host `https://api.housecallpro.com/*` | Reads the job list from Housecall Pro's public API with the user's API key. |
| Host `https://pro.housecallpro.com/*` | Reads each job's materials and miscellaneous costs using the user's existing Housecall Pro sign-in in this browser, and finds or creates the read-only "SHVR Data Export" API key in the user's API Key Management so they don't have to copy one. |
| `cookies` | Finds which ServiceTitan account the user is signed in to, from the domains of ServiceTitan's sign-in cookies and the value of its `st_tenant` cookie (the account name), so the export calls that account's address. Sign-in cookie values are never used, stored or sent. |
| Host `https://*.servicetitan.com/*` | Reads the user's ServiceTitan jobs, estimates, customers, invoices, leads and payments using their existing ServiceTitan sign-in in this browser. Each account lives on its own subdomain. |

**Remote code:** No, I am not using remote code.

**Data usage:** check *Personally identifiable information* (customer names, emails, phone numbers and addresses appear in the job list), *Financial and payment information* (job totals and costs), and *Authentication information* (the API key). Then certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** host `store/PRIVACY.md` somewhere public (a GitHub Gist or GitHub Pages works) and paste its URL.

## Distribution tab

**Visibility:** Unlisted. Only people with the link can find and install it. Share the listing link after it's approved.
