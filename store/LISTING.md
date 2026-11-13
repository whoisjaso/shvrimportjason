# Chrome Web Store listing

Paste these into the developer dashboard at <https://chrome.google.com/webstore/devconsole> when you submit `dist/hcp-job-costing-export-<version>.zip` (built with `sh extension/package.sh`).

## Store listing tab

**Name** (from the manifest): HCP Job Costing Export for SHVR

**Summary** (132 characters max):

> Download every Housecall Pro job with its materials and miscellaneous costs as spreadsheets you can open in Excel or Google Sheets.

**Description:**

> Get all of your Housecall Pro job costing out in one go.
>
> Job Costing Export reads every job and estimate in your Housecall Pro account, along with each job's materials and miscellaneous costs, and saves them as one zip file of spreadsheets:
>
> • jobs.csv: every job with its invoice number, status, customer, address, dates, totals, and assigned employees
> • materials.csv: every material on every job, with quantity, unit cost, total, vendor, and purchase status
> • miscellaneous_items.csv: every miscellaneous cost on every job, such as subcontractor labor
> • estimates.csv: every estimate with its number, status, customer, address, dates, and assigned employees
> • estimate_options.csv: every option on every estimate, with its total and approval status
>
> Each material and miscellaneous row includes the job ID and invoice number, so it links straight back to its job. Each job's original estimate ID matches an option ID in estimate_options.csv.
>
> How it works:
> 1. Paste your Housecall Pro API key (My Apps › All Apps › API Key Management). A read-only key is enough.
> 2. Sign in to Housecall Pro in Chrome as you normally do.
> 3. Click Export. A progress bar shows how far along it is, and the zip lands in your Downloads folder.
>
> It reads one job at a time with a pause between requests so it never overloads Housecall Pro, and if the export is interrupted it picks up where it left off.
>
> Your data goes only between your browser and Housecall Pro. Nothing is sent to us or anyone else.
>
> Requires a Housecall Pro plan with API access (MAX) and an admin user to create the API key. This extension is not made by or affiliated with Housecall Pro.

**Category:** Productivity (Workflow & Planning)

**Language:** English

**Screenshots:** `store/screenshot-running.png` (1280×800). The store needs at least one and accepts up to five; a "done" screenshot would be a good second.

**Icon:** `extension/icons/icon-128.png`

## Privacy practices tab

**Single purpose:**

> Export the user's own Housecall Pro jobs, job materials, and job miscellaneous costs to CSV spreadsheet files.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `storage` | Remembers the user's API key and saves export progress so an interrupted export can resume. |
| `unlimitedStorage` | Export progress for large accounts (thousands of jobs) can exceed the default local storage quota. |
| `downloads` | Saves the finished zip of spreadsheets to the user's Downloads folder and shows it in the folder on request. |
| Host `https://api.housecallpro.com/*` | Reads the job list from Housecall Pro's public API with the user's API key. |
| Host `https://pro.housecallpro.com/*` | Reads each job's materials and miscellaneous costs using the user's existing Housecall Pro sign-in in this browser. |

**Remote code:** No, I am not using remote code.

**Data usage:** check *Personally identifiable information* (customer names, emails, phone numbers and addresses appear in the job list), *Financial and payment information* (job totals and costs), and *Authentication information* (the API key). Then certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** host `store/PRIVACY.md` somewhere public (a GitHub Gist or GitHub Pages works) and paste its URL.

## Distribution tab

**Visibility:** Unlisted. Only people with the link can find and install it. Share the listing link after it's approved.
