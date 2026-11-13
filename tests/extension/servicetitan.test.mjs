import assert from "node:assert/strict";
import { test } from "node:test";

import { columnsOf, flatten } from "../../extension/lib/flatten.js";
import { AuthError, RequestError } from "../../extension/lib/hcp.js";
import { createServiceTitanClient, parseSearch, tenantsFromCookies } from "../../extension/lib/servicetitan.js";
import { createServiceTitanExporter } from "../../extension/lib/st-exporter.js";
import { memoryStore, unzip } from "./helpers.mjs";

test("tenants come from auth cookie hosts, then st_tenant", () => {
  const tenants = tenantsFromCookies([
    { name: ".AspNetCore.AUTHC1", domain: "actionexteriors_fortworth.eh.go.servicetitan.com", value: "x" },
    { name: ".AspNetCore.AUTHC1", domain: ".go.servicetitan.com", value: "x" },
    { name: "st_tenant", domain: ".servicetitan.com", value: "actionexteriors_fortworth" },
    { name: "st_tenant", domain: ".servicetitan.com", value: "other_tenant" },
    { name: "unrelated", domain: "foo.servicetitan.com", value: "x" },
  ]);
  assert.deepEqual(tenants, [
    { tenant: "actionexteriors_fortworth", host: "actionexteriors_fortworth.eh.go.servicetitan.com" },
    { tenant: "other_tenant", host: "other_tenant.eh.go.servicetitan.com" },
  ]);
});

test("search results are found under common list and total keys", () => {
  assert.deepEqual(parseSearch({ Data: [{ Id: 1 }], Total: 40 }), { records: [{ Id: 1 }], total: 40 });
  assert.deepEqual(parseSearch({ result: { items: [{ id: 2 }], totalCount: 3 } }), { records: [{ id: 2 }], total: 3 });
  assert.deepEqual(parseSearch([{ Id: 3 }]), { records: [{ Id: 3 }], total: null });
  assert.throws(() => parseSearch({ message: "nope" }, "Job"), /Job search came back without a list/);
});

test("search posts the page with the session, and a login page means signed out", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, type: "basic", ok: true, headers: { get: () => null }, text: async () => "<html>Sign in</html>" };
  };
  const client = createServiceTitanClient({ host: "t1.eh.go.servicetitan.com", fetch, delayMs: 0 });
  await assert.rejects(client.searchPage("Invoice", 2), (error) => error instanceof AuthError && error.kind === "session");
  assert.equal(calls[0].url, "https://t1.eh.go.servicetitan.com/Search/Invoice");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(JSON.parse(calls[0].init.body), { filter: { page: 2 }, criteriaString: "{}" });
});

test("flatten keeps every field: dotted nesting, joined values, JSON lists", () => {
  const row = flatten({ Id: 7, Customer: { Name: "Ada", Address: { City: "Fort Worth" } }, Tags: ["a", "b"], Items: [{ Sku: 1 }], Note: null, Extra: {} });
  assert.deepEqual(row, {
    Id: "7",
    "Customer.Name": "Ada",
    "Customer.Address.City": "Fort Worth",
    Tags: "a; b",
    Items: '[{"Sku":1}]',
    Note: "",
    Extra: "",
  });
  assert.deepEqual(columnsOf([{ a: 1 }, { b: 2, a: 3 }]), ["a", "b"]);
});

// Pages per search; a repeated page means the server ignored `page`.
// attachments: estimate id -> { documents, measurements }; files: fileRef -> text.
function fakeClient(pages, { failOnce, attachments = {}, files = {} } = {}) {
  const requested = [];
  let failed = false;
  return {
    requested,
    client: {
      checkSession: async () => {},
      searchPage: async (entity, page) => {
        requested.push(`${entity}:${page}`);
        if (failOnce === `${entity}:${page}` && !failed) {
          failed = true;
          throw new Error("worker stopped");
        }
        return (pages[entity] ?? [])[page - 1] ?? { records: [], total: null };
      },
      documents: async (id) => {
        requested.push(`docs:${id}`);
        return (attachments[id]?.documents ?? []).map((meta) => ({ ...meta, fileRef: meta.filename }));
      },
      measurements: async (id) => (attachments[id]?.measurements ?? []).map((meta) => ({ ...meta, fileRef: meta.file.fileUrl })),
      download: async (ref) => {
        requested.push(`file:${ref}`);
        if (!(ref in files)) throw new RequestError("/Attach/Job returned HTTP 404.", 404);
        return { bytes: new TextEncoder().encode(files[ref]), type: "text/plain", disposition: "" };
      },
    },
  };
}

function memoryFiles() {
  const blobs = new Map();
  return {
    blobs,
    put: async (key, bytes, type) => blobs.set(key, new Blob([bytes], { type })),
    get: async (key) => blobs.get(key),
    clear: async () => blobs.clear(),
  };
}

function exporterFor(store, fake, { files = memoryFiles(), onFinished = async () => {} } = {}) {
  return createServiceTitanExporter({ store, files, makeClient: () => fake.client, now: () => Date.UTC(2026, 10, 13, 15), onFinished });
}

async function zipBytes(exporter) {
  const { parts, fileName } = await exporter.archive();
  return { bytes: new Uint8Array(await new Blob(parts).arrayBuffer()), fileName };
}

const PAGES = {
  Job: [
    { records: [{ Id: 1, JobNumber: "J1", Customer: { Name: "Ada" } }, { Id: 2, JobNumber: "J2" }], total: 3 },
    { records: [{ Id: 3, JobNumber: "J3", Total: 125.5 }], total: 3 },
  ],
  // The server ignores `page` and keeps sending page 1.
  Customer: [
    { records: [{ Id: 10, Name: "Ada" }], total: null },
    { records: [{ Id: 10, Name: "Ada" }], total: null },
  ],
};

test("exports every search to its own CSV with all fields", async () => {
  const store = memoryStore({ apiKey: "keep-me", provider: "servicetitan", jobs: ["stale hcp data"] });
  const fake = fakeClient(PAGES);
  let finished = null;
  const exporter = exporterFor(store, fake, {
    onFinished: async (run) => {
      finished = run;
    },
  });

  await exporter.start({ tenant: "t1", host: "t1.eh.go.servicetitan.com" });

  assert.equal(finished.status, "done");
  assert.equal(finished.entities.jobs.count, 3);
  assert.equal(finished.entities.customers.count, 1);
  assert.equal(store.data.apiKey, "keep-me");
  assert.equal("jobs" in store.data, false);
  // Jobs stop at the total; customers stop when a page brings nothing new.
  assert.deepEqual(fake.requested.filter((r) => /^(Job|Customer):/.test(r)), ["Job:1", "Job:2", "Customer:1", "Customer:2"]);

  const { bytes, fileName } = await zipBytes(exporter);
  assert.equal(fileName, "SHVR Export - t1 - 2026-11-13.zip");
  assert.deepEqual(unzip(bytes, "jobs.csv").split("\r\n"), ["\uFEFFId,JobNumber,Customer.Name,Total", "1,J1,Ada,", "2,J2,,", "3,J3,,125.5", ""]);
  assert.equal(unzip(bytes, "customers.csv"), "\uFEFFId,Name\r\n10,Ada\r\n");
  assert.equal(unzip(bytes, "payments.csv"), "\uFEFF\r\n");
});

test("attachments come once per file through estimates, in job folders, with a CSV of all of them", async () => {
  const pages = {
    ...PAGES,
    Estimate: [{ records: [{ Id: 100, JobId: 1 }, { Id: 101, JobId: 1 }, { Id: 102, JobId: null }], total: 3 }],
  };
  const photo = { id: 9, filename: "Attaches/a/photo.jpg", originalFilename: "photo.jpg", ownerType: 1, ownerId: 1, type: 1 };
  const fake = fakeClient(pages, {
    attachments: {
      100: {
        documents: [photo, { id: 10, filename: "Attaches/b/gone.pdf", originalFilename: "gone.pdf" }],
        measurements: [{ id: "m1", name: "EagleView", ownerType: 2, file: { fileUrl: "EagleView/Report-1.pdf", fileType: 0 } }],
      },
      // The same job through its second estimate: the photo is already saved,
      // and pricebook / supplier product images are listed but not downloaded.
      101: {
        documents: [
          photo,
          { id: 12, filename: "Images/Material/SRSDistribution/abc.", originalFilename: "Product Image", ownerType: 8, type: 8 },
          { id: 13, filename: "Images/Service/ServiceTitan_Pricebook/d.jpg", originalFilename: "d.jpg", ownerType: 1, type: 1 },
        ],
      },
      102: { documents: [{ id: 11, filename: "Attaches/c/photo.jpg", originalFilename: "photo.jpg", ownerType: 5, type: 1 }] },
    },
    files: { "Attaches/a/photo.jpg": "JPEG", "EagleView/Report-1.pdf": "PDF", "Attaches/c/photo.jpg": "OTHER" },
  });
  const store = memoryStore();
  const exporter = exporterFor(store, fake);
  await exporter.start({ tenant: "t1", host: "t1.eh.go.servicetitan.com" });

  assert.equal(store.data.run.status, "done");
  assert.deepEqual(store.data.run.attachments, { total: 3, done: 3, files: 3, failed: 1, skipped: 2, bytes: 12 });
  assert.equal(fake.requested.some((r) => r.startsWith("file:Images/")), false);
  assert.equal(fake.requested.filter((r) => r === "file:Attaches/a/photo.jpg").length, 1);
  // The page's thumbnail points at the last photo saved; no estimate is left in progress.
  assert.deepEqual(store.data.run.preview, { key: "att:3", name: "photo.jpg", jobNumber: "" });
  assert.equal(store.data.run.step, null);

  const { bytes } = await zipBytes(exporter);
  assert.equal(unzip(bytes, "attachments/job J1/documents/photo.jpg"), "JPEG");
  assert.equal(unzip(bytes, "attachments/job J1/measurements/Report-1.pdf"), "PDF");
  assert.equal(unzip(bytes, "attachments/estimate 102/documents/photo.jpg"), "OTHER");

  const [header, ...rows] = unzip(bytes, "attachments.csv").replace("\uFEFF", "").trim().split("\r\n");
  assert.match(header, /^kind,category,job_id,job_number,estimate_id,file_name,zip_path,content_type,size_bytes,status,error,file_ref,info\.id,/);
  assert.deepEqual(
    rows.map((row) => row.split(",").slice(0, 11)),
    [
      ["document", "job photo", "1", "J1", "100", "photo.jpg", "attachments/job J1/documents/photo.jpg", "text/plain", "4", "saved", ""],
      ["document", "file", "1", "J1", "100", "gone.pdf", "attachments/job J1/documents/gone.pdf", "", "", "failed", "/Attach/Job returned HTTP 404."],
      ["measurement", "measurement", "1", "J1", "100", "Report-1.pdf", "attachments/job J1/measurements/Report-1.pdf", "text/plain", "3", "saved", ""],
      ["document", "catalog image", "1", "J1", "101", "Product Image", "", "", "", "skipped", "Catalog image (pricebook or supplier product photo)"],
      ["document", "catalog image", "1", "J1", "101", "d.jpg", "", "", "", "skipped", "Catalog image (pricebook or supplier product photo)"],
      ["document", "sales photo", "", "", "102", "photo.jpg", "attachments/estimate 102/documents/photo.jpg", "text/plain", "5", "saved", ""],
    ],
  );
});

test("an export stopped during attachments resumes at the next estimate", async () => {
  const pages = { Estimate: [{ records: [{ Id: 100, JobId: 1 }, { Id: 101, JobId: 2 }], total: 2 }] };
  const options = { attachments: { 100: { documents: [{ filename: "a.pdf" }] }, 101: { documents: [{ filename: "b.pdf" }] } }, files: { "a.pdf": "A", "b.pdf": "B" } };
  const store = memoryStore();
  const files = memoryFiles();
  const crashing = fakeClient(pages, options);
  crashing.client.documents = async (id) => {
    if (id === "101") throw new Error("worker stopped");
    return [{ filename: "a.pdf", fileRef: "a.pdf" }];
  };
  await exporterFor(store, crashing, { files }).start({ tenant: "t1", host: "h.servicetitan.com" });
  assert.equal(store.data.run.status, "error");
  assert.equal(store.data.run.attachments.done, 1);

  const healthy = fakeClient(pages, options);
  await exporterFor(store, healthy, { files }).retry();
  assert.deepEqual(healthy.requested, ["docs:101", "file:b.pdf"]);
  assert.equal(store.data.run.attachments.files, 2);
});

test("a stopped export resumes at the page that failed", async () => {
  const store = memoryStore();
  const crashing = fakeClient(PAGES, { failOnce: "Job:2" });
  await exporterFor(store, crashing).start({ tenant: "t1", host: "t1.eh.go.servicetitan.com" });
  assert.equal(store.data.run.status, "error");
  assert.equal(store.data.run.entities.jobs.count, 2);

  const healthy = fakeClient(PAGES);
  await exporterFor(store, healthy).retry();
  assert.equal(healthy.requested[0], "Job:2");
  assert.equal(store.data.run.status, "done");
  assert.equal(store.data.run.entities.jobs.count, 3);
});

test("signed out of ServiceTitan stops before reading anything", async () => {
  const store = memoryStore();
  const fake = fakeClient(PAGES);
  fake.client.checkSession = async () => {
    throw new AuthError("session", "signed out");
  };
  await exporterFor(store, fake).start({ tenant: "t1", host: "t1.eh.go.servicetitan.com" });
  assert.equal(store.data.run.error.kind, "session");
  assert.deepEqual(fake.requested, []);
});
