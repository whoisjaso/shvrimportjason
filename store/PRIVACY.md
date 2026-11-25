# Privacy policy: SHVR Data Export

Last updated: November 16, 2026

SHVR Data Export is a Chrome extension that downloads your own records from your field-service software (Housecall Pro, ServiceTitan or Jobber) to files on your computer.

## What the extension reads

Housecall Pro:

- **Your Housecall Pro API key.** After you sign in, the extension looks in your company's API Key Management for a key whose note mentions SHVR and uses it. If there isn't one, it creates a read-only key with the note "SHVR Data Export", the same way the API Key Management page does. If it can't (for example, you're not an admin), it asks you to paste a key. The key is stored only in your browser's local extension storage; removing the extension deletes it, and you can delete the key in API Key Management at any time.
- **Your jobs and estimates**, from Housecall Pro's public API (`api.housecallpro.com`), using that API key. These include customer names, contact details, addresses, dates and amounts.
- **Each job's materials and miscellaneous costs**, from Housecall Pro (`pro.housecallpro.com`), using the sign-in you already have in your browser.

ServiceTitan:

- **Your jobs, estimates, customers, invoices, leads and payments**, from your ServiceTitan account (`*.servicetitan.com`), using the sign-in you already have in your browser. These include customer names, contact details, addresses, dates and amounts.
- **Each job's documents, photos and measurement reports**, downloaded from the same ServiceTitan account. While an export runs they are kept in your browser's local extension storage until the zip is saved.
- **Which ServiceTitan account you're signed in to**, worked out from the web addresses ServiceTitan's cookies belong to and the account name in its `st_tenant` cookie. The extension doesn't use, store or send your sign-in cookie values.

Jobber:

- **Your jobs, clients, quotes, invoices and requests, and the line items on jobs, quotes and invoices**, from Jobber's API (`api.getjobber.com`), using the sign-in you already have in your browser. These include client names, contact details, addresses, dates and amounts.
- **The files and photos attached to them**, downloaded from the links Jobber gives for each file (`jobber.s3.amazonaws.com` and `jobber-production-general-uploads.s3.amazonaws.com`). While an export runs they are kept in your browser's local extension storage until the zip is saved.

In every case the extension never reads, copies or stores your password or sign-in cookie values; your browser attaches your sign-in to those requests the same way it does when you use the website.

## What it does with that data

It turns the data into CSV files, zips them, and saves the zip to your Downloads folder; downloaded attachments go into a second zip beside it. While an export runs, progress and downloaded files are kept in your browser's local extension storage so an interrupted export can resume; starting a new export replaces them, and removing the extension deletes them.

## What it never does

- It sends no data anywhere except Housecall Pro's, ServiceTitan's or Jobber's own servers (and the storage Jobber's download links point to).
- It has no server of its own, no analytics, no tracking and no ads.
- It does not sell, share or transfer your data to anyone.
- It changes nothing in your account except, in Housecall Pro, creating the one read-only "SHVR Data Export" API key described above when you don't already have an SHVR key. Everything else it requests only reads; ServiceTitan's search pages and Jobber's API are requested with POST, the way their websites do, but those requests only read.

## Contact

Questions about this policy: [add your contact email here].
