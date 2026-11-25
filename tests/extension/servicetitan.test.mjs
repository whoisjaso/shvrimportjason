import assert from "node:assert/strict";
import { test } from "node:test";

import { columnsOf, flatten } from "../../extension/lib/flatten.js";
import { AuthError, RequestError } from "../../extension/lib/hcp.js";
import { createServiceTitanClient, parseSearch, tenantsFromCookies } from "../../extension/lib/servicetitan.js";
import { DOWNLOAD_CONCURRENCY, createServiceTitanExporter } from "../../extension/lib/st-exporter.js";
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

test("a download whose body drops mid-stream is retried", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    const dropped = calls === 1;
    return {
      status: 200,
      type: "basic",
      ok: true,
      headers: { get: (name) => (name === "Content-Type" ? "image/jpeg" : null) },
      arrayBuffer: async () => {
        if (dropped) throw new TypeError("Failed to fetch");
        return new Uint8Array([7, 8]).buffer;
      },
    };
  };
  const client = createServiceTitanClient({ host: HOST, fetch, sleep: async () => {} });
  const file = await client.download("Attaches/a/photo.jpg");
  assert.deepEqual([...file.bytes], [7, 8]);
  assert.equal(calls, 2);
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
// attachments: "job:<id>" or "estimate:<id>" -> { documents, measurements };
// files: fileRef -> text.
function fakeClient(pages, { failOnce, attachments = {}, files = {} } = {}) {
  const requested = [];
  let failed = false;
  const docs = (key) => (attachments[key]?.documents ?? []).map((meta) => ({ ...meta, fileRef: meta.filename }));
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
      jobAttachments: async (id) => {
        requested.push(`job:${id}`);
        return docs(`job:${id}`);
      },
      jobMeasurements: async (id) => (attachments[`job:${id}`]?.measurements ?? []).map((meta) => ({ ...meta, fileRef: meta.file.name })),
      estimateDocuments: async (id) => {
        requested.push(`estimate:${id}`);
        return docs(`estimate:${id}`);
      },
      estimateMeasurements: async (id) => (attachments[`estimate:${id}`]?.measurements ?? []).map((meta) => ({ ...meta, fileRef: meta.file.fileUrl })),
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

async function zipBytes(archive) {
  const { parts, fileName } = await archive;
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
const HOST = "t1.eh.go.servicetitan.com";

test("exports every search to its own CSV with all fields, and skips attachments when not asked", async () => {
  const store = memoryStore({ apiKey: "keep-me", provider: "servicetitan", jobs: ["stale hcp data"] });
  const fake = fakeClient(PAGES);
  let finished = null;
  const exporter = exporterFor(store, fake, {
    onFinished: async (run) => {
      finished = run;
    },
  });

  await exporter.start({ tenant: "t1", host: HOST, includeAttachments: false });

  assert.equal(finished.status, "done");
  assert.equal(finished.entities.jobs.count, 3);
  assert.equal(finished.entities.customers.count, 1);
  assert.equal(store.data.apiKey, "keep-me");
  assert.equal("jobs" in store.data, false);
  // Jobs stop at the total; customers stop when a page brings nothing new.
  assert.deepEqual(fake.requested.filter((r) => /^(Job|Customer):/.test(r)), ["Job:1", "Job:2", "Customer:1", "Customer:2"]);
  assert.equal(fake.requested.some((r) => r.startsWith("job:")), false);
  assert.equal(await exporter.attachmentsArchive(), null);

  const { bytes, fileName } = await zipBytes(exporter.archive());
  assert.equal(fileName, "SHVR Export - t1 - 2026-11-13.zip");
  assert.deepEqual(unzip(bytes, "jobs.csv").split("\r\n"), ["\uFEFFId,JobNumber,Customer.Name,Total", "1,J1,Ada,", "2,J2,,", "3,J3,,125.5", ""]);
  assert.equal(unzip(bytes, "customers.csv"), "\uFEFFId,Name\r\n10,Ada\r\n");
  assert.equal(unzip(bytes, "payments.csv"), "\uFEFF\r\n");
});

test("attachments come once per file, listed per job, in a second zip with a CSV of all of them", async () => {
  const pages = {
    ...PAGES,
    // 100 and 101 share job 1; 102 has no job; 103's job isn't in the job search.
    Estimate: [{ records: [{ Id: 100, JobId: 1 }, { Id: 101, JobId: 1 }, { Id: 102, JobId: null }, { Id: 103, JobId: 4, JobNumber: "J4" }], total: 4 }],
  };
  const photo = { id: 9, filename: "Attaches/a/photo.jpg", originalFilename: "photo.jpg", ownerType: 1, ownerId: 1 };
  const fake = fakeClient(pages, {
    attachments: {
      "job:1": {
        documents: [
          photo,
          { id: 10, filename: "Attaches/b/gone.pdf", originalFilename: "gone.pdf", ownerType: 1 },
          // Text-message media is the customer's, not a catalog image.
          { id: 11, filename: "Messages/Media/2026-text.jpg", originalFilename: "2026-text.jpg", ownerType: 1 },
          // A supplier product photo copied onto the job: listed, not downloaded.
          { id: 12, filename: "Images/Material/SRSDistribution/abc.", originalFilename: "Product Image", ownerType: 1 },
        ],
        measurements: [{ id: "m1", name: "EagleView", source: "EagleView", file: { name: "EagleView/Report-1.pdf", fileType: "PDF" } }],
      },
      "job:4": { documents: [{ id: 14, filename: "Attaches/d/signed", originalFilename: "Estimate_signed", ownerType: 1 }] },
      "estimate:102": {
        documents: [
          photo,
          { id: 13, filename: "Attaches/c/photo.jpg", originalFilename: "photo.jpg", ownerType: 5, type: 1 },
          { id: 15, filename: "Images/Service/ServiceTitan_Pricebook/d.jpg", originalFilename: "d.jpg", ownerType: 8, type: 1 },
        ],
      },
    },
    files: {
      "Attaches/a/photo.jpg": "JPEG",
      "Messages/Media/2026-text.jpg": "SMS",
      "EagleView/Report-1.pdf": "PDF",
      "Attaches/d/signed": "SIGNED",
      "Attaches/c/photo.jpg": "OTHER",
    },
  });
  const store = memoryStore();
  const exporter = exporterFor(store, fake);
  await exporter.start({ tenant: "t1", host: HOST });

  assert.equal(store.data.run.status, "done");
  // Jobs 1-3 from the search, job 4 from its estimate, estimate 102 on its own.
  assert.deepEqual(store.data.run.attachments, { total: 5, done: 5, files: 5, failed: 1, skipped: 2, bytes: 21 });
  assert.deepEqual(fake.requested.filter((r) => /^(job|estimate):/.test(r)).sort(), ["estimate:102", "job:1", "job:2", "job:3", "job:4"]);
  assert.equal(fake.requested.some((r) => r.startsWith("file:Images/")), false);
  assert.equal(fake.requested.filter((r) => r === "file:Attaches/a/photo.jpg").length, 1);

  const { bytes: dataZip } = await zipBytes(exporter.archive());
  assert.throws(() => unzip(dataZip, "attachments.csv"));

  const { bytes, fileName } = await zipBytes(exporter.attachmentsArchive());
  assert.equal(fileName, "SHVR Attachments - t1 - 2026-11-13.zip");
  assert.equal(unzip(bytes, "job J1/documents/photo.jpg"), "JPEG");
  assert.equal(unzip(bytes, "job J1/documents/2026-text.jpg"), "SMS");
  assert.equal(unzip(bytes, "job J1/measurements/Report-1.pdf"), "PDF");
  assert.equal(unzip(bytes, "job J4/documents/Estimate_signed"), "SIGNED");
  assert.equal(unzip(bytes, "estimate 102/documents/photo.jpg"), "OTHER");

  const [header, ...rows] = unzip(bytes, "attachments.csv").replace("\uFEFF", "").trim().split("\r\n");
  assert.match(header, /^kind,category,job_id,job_number,estimate_id,file_name,zip_path,content_type,size_bytes,status,error,file_ref,info\.id,/);
  assert.deepEqual(
    rows.map((row) => row.split(",").slice(0, 11)),
    [
      ["document", "job photo", "1", "J1", "", "photo.jpg", "job J1/documents/photo.jpg", "text/plain", "4", "saved", ""],
      ["document", "job document", "1", "J1", "", "gone.pdf", "job J1/documents/gone.pdf", "", "", "failed", "/Attach/Job returned HTTP 404."],
      ["document", "job photo", "1", "J1", "", "2026-text.jpg", "job J1/documents/2026-text.jpg", "text/plain", "3", "saved", ""],
      ["document", "catalog image", "1", "J1", "", "Product Image", "", "", "", "skipped", "Catalog image (pricebook or supplier product photo)"],
      ["measurement", "measurement", "1", "J1", "", "Report-1.pdf", "job J1/measurements/Report-1.pdf", "text/plain", "3", "saved", ""],
      ["document", "job document", "4", "J4", "", "Estimate_signed", "job J4/documents/Estimate_signed", "text/plain", "6", "saved", ""],
      ["document", "sales photo", "", "", "102", "photo.jpg", "estimate 102/documents/photo.jpg", "text/plain", "5", "saved", ""],
      ["document", "catalog image", "", "", "102", "d.jpg", "", "", "", "skipped", "Catalog image (pricebook or supplier product photo)"],
    ],
  );
});

test(`downloads run ${DOWNLOAD_CONCURRENCY} at a time`, async () => {
  const names = Array.from({ length: 100 }, (_, i) => `Attaches/x/${i}.jpg`);
  const fake = fakeClient(
    { Job: [{ records: [{ Id: 1, JobNumber: "J1" }], total: 1 }] },
    { attachments: { "job:1": { documents: names.map((filename) => ({ filename, ownerType: 1 })) } } },
  );
  let inFlight = 0;
  let most = 0;
  fake.client.download = async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { bytes: new Uint8Array([1]), type: "image/jpeg", disposition: "" };
  };
  const store = memoryStore();
  await exporterFor(store, fake).start({ tenant: "t1", host: HOST });
  assert.equal(most, DOWNLOAD_CONCURRENCY);
  assert.equal(store.data.run.attachments.files, 100);
});

test("an export stopped during attachments resumes at the unfinished jobs", async () => {
  const pages = { Job: [{ records: [{ Id: 1, JobNumber: "J1" }, { Id: 2, JobNumber: "J2" }], total: 2 }] };
  const options = {
    attachments: { "job:1": { documents: [{ filename: "a.pdf" }] }, "job:2": { documents: [{ filename: "b.pdf" }] } },
    files: { "a.pdf": "A", "b.pdf": "B" },
  };
  const store = memoryStore();
  const files = memoryFiles();
  const crashing = fakeClient(pages, options);
  const listJob = crashing.client.jobAttachments;
  crashing.client.jobAttachments = async (id) => {
    if (id === "2") throw new Error("worker stopped");
    return listJob(id);
  };
  await exporterFor(store, crashing, { files }).start({ tenant: "t1", host: HOST });
  assert.equal(store.data.run.status, "error");
  assert.equal(store.data.run.attachments.done, 1);

  const healthy = fakeClient(pages, options);
  await exporterFor(store, healthy, { files }).retry();
  assert.deepEqual(healthy.requested, ["job:2", "file:b.pdf"]);
  assert.equal(store.data.run.status, "done");
  assert.equal(store.data.run.attachments.files, 2);
});

test("a job ServiceTitan can't list gets a failed row, and the rest of the run finishes", async () => {
  const pages = { Job: [{ records: [{ Id: 1, JobNumber: "J1" }, { Id: 2, JobNumber: "J2" }], total: 2 }] };
  const fake = fakeClient(pages, { attachments: { "job:2": { documents: [{ filename: "b.pdf" }] } }, files: { "b.pdf": "B" } });
  const listJob = fake.client.jobAttachments;
  fake.client.jobAttachments = async (id) => {
    if (id === "1") throw new RequestError("ServiceTitan had a problem (HTTP 500).", 500);
    return listJob(id);
  };
  const store = memoryStore();
  const exporter = exporterFor(store, fake);
  await exporter.start({ tenant: "t1", host: HOST });
  assert.equal(store.data.run.status, "done");
  assert.deepEqual(store.data.run.attachments, { total: 2, done: 2, files: 1, failed: 1, skipped: 0, bytes: 1 });

  const { bytes } = await zipBytes(exporter.attachmentsArchive());
  const rows = unzip(bytes, "attachments.csv").replace("\uFEFF", "").trim().split("\r\n").slice(1);
  assert.match(rows[0], /^listing,listing,1,J1,.*,failed,Couldn't list this job's attachments: ServiceTitan had a problem \(HTTP 500\)\./);
  assert.equal(unzip(bytes, "job J2/documents/b.pdf"), "B");
});

test("signed out mid-download stops the run as a session error", async () => {
  const fake = fakeClient(
    { Job: [{ records: [{ Id: 1, JobNumber: "J1" }], total: 1 }] },
    { attachments: { "job:1": { documents: [{ filename: "a.pdf" }, { filename: "b.pdf" }] } } },
  );
  fake.client.download = async () => {
    throw new AuthError("session", "signed out");
  };
  const store = memoryStore();
  await exporterFor(store, fake).start({ tenant: "t1", host: HOST });
  assert.equal(store.data.run.status, "error");
  assert.equal(store.data.run.error.kind, "session");
  assert.equal(store.data.run.attachments.done, 0);
  assert.equal("statt:job:1" in store.data, false);
});

test("a stopped export resumes at the page that failed", async () => {
  const store = memoryStore();
  const crashing = fakeClient(PAGES, { failOnce: "Job:2" });
  await exporterFor(store, crashing).start({ tenant: "t1", host: HOST });
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
  await exporterFor(store, fake).start({ tenant: "t1", host: HOST });
  assert.equal(store.data.run.error.kind, "session");
  assert.deepEqual(fake.requested, []);
});
