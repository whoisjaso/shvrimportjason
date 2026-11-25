import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthError, RequestError } from "../../extension/lib/hcp.js";
import { ENTITIES, createJobberClient } from "../../extension/lib/jobber.js";
import { createJobberExporter, linkExpiry } from "../../extension/lib/jobber-exporter.js";
import { memoryStore, unzip } from "./helpers.mjs";

// A fetch that answers GraphQL queries with `answer(query)` and S3 links
// with `files[url]`.
function graphqlFetch(answer, { files = {}, budget = 100000 } = {}) {
  const queries = [];
  const fetch = async (url, init) => {
    if (!url.includes("api.getjobber.com")) {
      const text = files[url];
      return {
        status: text === undefined ? 403 : 200,
        type: "cors",
        ok: text !== undefined,
        headers: { get: (name) => (name === "Content-Type" ? "image/jpeg" : null) },
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
        text: async () => "",
      };
    }
    const { query } = JSON.parse(init.body);
    queries.push(query);
    const body = { extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: budget, restoreRate: 500 } } }, ...answer(query) };
    return { status: 200, type: "cors", ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { fetch, queries };
}

test("signed out comes back as UNAUTHENTICATED errors on an HTTP 200", async () => {
  const { fetch } = graphqlFetch(() => ({ errors: [{ message: "hidden", extensions: { code: "UNAUTHENTICATED" } }] }));
  const client = createJobberClient({ fetch, delayMs: 0 });
  await assert.rejects(client.account(), (error) => error instanceof AuthError && error.kind === "session");
});

test("a page waits for the cost budget to refill before asking", async () => {
  const slept = [];
  const { fetch, queries } = graphqlFetch(
    (query) => (query.includes("account") ? { data: { account: { id: "A", name: "Pink's" } } } : { data: { jobs: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } }),
    { budget: 8000 },
  );
  const client = createJobberClient({ fetch, delayMs: 0, sleep: async (ms) => slept.push(ms) });
  await client.account();
  await client.listPage(ENTITIES[0], null, true);
  // A page with files is estimated at 48,000 points; 8,000 left at 500/s.
  assert.deepEqual(slept, [80_000]);
  assert.equal(queries.length, 2);
});

test("a record's files past the first hundred are paged by id", async () => {
  const file = (n) => ({ id: `f${n}`, fileName: `${n}.jpg`, downloadUrl: `https://s3/${n}` });
  const { fetch, queries } = graphqlFetch((query) =>
    query.startsWith("{ job(")
      ? { data: { job: { noteAttachments: { totalCount: 101, pageInfo: { hasNextPage: false }, nodes: [file(101)] } } } }
      : {
          data: {
            jobs: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: "c1" },
              nodes: [{ id: "J1", jobNumber: 7, noteAttachments: { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: "a100" }, nodes: [file(1)] } }],
            },
          },
        },
  );
  const page = await createJobberClient({ fetch, delayMs: 0 }).listPage(ENTITIES[0], null, true);
  assert.deepEqual(page.records[0].files.map((f) => f.id), ["f1", "f101"]);
  assert.match(queries[1], /job\(id: "J1"\) \{ noteAttachments\(first: 100, after: "a100"\)/);
});

// Pages per entity key; each page: records (with files when listed).
function fakeClient(pages, files = {}) {
  const requested = [];
  return {
    requested,
    client: {
      account: async () => ({ id: "A", name: "Pink's Windows Austin" }),
      listPage: async (entity, after, withFiles) => {
        const index = after ? Number(after) : 0;
        requested.push(`${entity.key}:${index}`);
        const list = pages[entity.key] ?? [];
        const records = (list[index] ?? []).map(({ files: f, ...record }) => (withFiles ? { ...record, files: f ?? [] } : record));
        return { records, total: list.flat().length, endCursor: String(index + 1), hasNextPage: index + 1 < list.length };
      },
      download: async (url) => {
        requested.push(`file:${url}`);
        if (!(url in files)) throw new RequestError("The file link returned HTTP 403.", 403);
        return { bytes: new TextEncoder().encode(files[url]), type: "image/jpeg", disposition: "" };
      },
    },
  };
}

function memoryFiles() {
  const blobs = new Map();
  return { put: async (key, bytes, type) => blobs.set(key, new Blob([bytes], { type })), get: async (key) => blobs.get(key), clear: async () => blobs.clear() };
}

const exporterFor = (store, fake, files = memoryFiles()) =>
  createJobberExporter({ store, files, makeClient: () => fake.client, now: () => Date.UTC(2026, 10, 16, 15) });

async function zipBytes(archive) {
  const { parts, fileName } = await archive;
  return { bytes: new Uint8Array(await new Blob(parts).arrayBuffer()), fileName };
}

const PAGES = {
  jobs: [
    [
      { id: "J1", jobNumber: 101, title: "Windows", client: { id: "C1", name: "Ada" }, files: [{ id: "f1", fileName: "front.jpg", downloadUrl: "https://s3/f1" }, { id: "f2", fileName: "gone.jpg", downloadUrl: "https://s3/f2" }] },
      { id: "J2", jobNumber: 102, title: "Gutters" },
    ],
    [{ id: "J3", jobNumber: 103, files: [{ id: "f3", fileName: "front.jpg", downloadUrl: "https://s3/f3" }] }],
  ],
  clients: [[{ id: "C1", name: "Ada", tags: { nodes: [{ label: "vip" }] } }]],
  // Invoices list their jobs' files again.
  invoices: [[{ id: "I1", invoiceNumber: 9, files: [{ id: "f4", fileName: "receipt.pdf", downloadUrl: "https://s3/f4" }, { id: "f1", fileName: "front.jpg", downloadUrl: "https://s3/f1-again" }] }]],
};
const FILES = { "https://s3/f1": "ONE", "https://s3/f3": "THREE", "https://s3/f4": "PDF" };

test("exports every search page by page, and the files in a second zip", async () => {
  const store = memoryStore();
  const fake = fakeClient(PAGES, FILES);
  const exporter = exporterFor(store, fake);
  await exporter.start({ includeAttachments: true });

  const run = store.data.run;
  assert.equal(run.status, "done");
  assert.equal(run.company, "Pink's Windows Austin");
  assert.deepEqual(fake.requested.filter((r) => r.startsWith("jobs:")), ["jobs:0", "jobs:1"]);
  assert.deepEqual(run.attachments, { total: 3, done: 3, listed: 4, files: 3, failed: 1, bytes: 11 });

  const { bytes: data, fileName } = await zipBytes(exporter.archive());
  assert.equal(fileName, "SHVR Export - Pink's Windows Austin - 2026-11-16.zip");
  assert.deepEqual(unzip(data, "jobs.csv").split("\r\n").slice(0, 2), ["\uFEFFid,jobNumber,title,client.id,client.name", "J1,101,Windows,C1,Ada"]);
  assert.equal(unzip(data, "clients.csv"), "\uFEFFid,name,tags.nodes\r\nC1,Ada,\"[{\"\"label\"\":\"\"vip\"\"}]\"\r\n");

  const { bytes, fileName: attName } = await zipBytes(exporter.attachmentsArchive());
  assert.equal(attName, "SHVR Attachments - Pink's Windows Austin - 2026-11-16.zip");
  assert.equal(unzip(bytes, "job 101/front.jpg"), "ONE");
  assert.equal(unzip(bytes, "job 103/front.jpg"), "THREE");
  assert.equal(unzip(bytes, "invoice 9/receipt.pdf"), "PDF");
  const rows = unzip(bytes, "attachments.csv").replace("\uFEFF", "").trim().split("\r\n");
  assert.match(rows[0], /^record_type,record_id,record_number,file_name,zip_path,content_type,size_bytes,status,error,file_id,info\.id,info\.fileName$/);
  assert.equal(rows[2], "job,J1,101,gone.jpg,job 101/gone.jpg,,,failed,The file link returned HTTP 403.,f2,f2,gone.jpg");
  // The repeated job photo isn't fetched again; its row points at the job's copy.
  assert.equal(rows.at(-1), "invoice,I1,9,front.jpg,job 101/front.jpg,,,duplicate,,f1,f1,front.jpg");
  assert.equal(fake.requested.includes("file:https://s3/f1-again"), false);
  assert.throws(() => unzip(bytes, "invoice 9/front.jpg"));
});

test("links only: nothing downloads, and the data zip lists every file's link and expiry", async () => {
  const signed = "https://jobber.s3.amazonaws.com/abc?X-Amz-Date=20261116T170627Z&X-Amz-Expires=259200&X-Amz-Signature=x";
  const pages = { jobs: [[{ id: "J1", jobNumber: 101, files: [{ id: "f1", fileName: "front.jpg", contentType: "image/jpeg", fileSize: 1200, downloadUrl: signed }] }]] };
  const store = memoryStore();
  const fake = fakeClient(pages, {});
  const exporter = exporterFor(store, fake);
  await exporter.start({ includeAttachments: true, linksOnly: true });

  assert.equal(store.data.run.status, "done");
  assert.deepEqual(store.data.run.links, { files: 1 });
  assert.equal(fake.requested.some((r) => r.startsWith("file:")), false);
  assert.equal(await exporter.attachmentsArchive(), null);
  const { bytes } = await zipBytes(exporter.archive());
  assert.deepEqual(unzip(bytes, "attachment_links.csv").replace("\uFEFF", "").trim().split("\r\n"), [
    "record_type,record_id,record_number,file_id,file_name,content_type,size_bytes,created_at,description,url,expires_at",
    `job,J1,101,f1,front.jpg,image/jpeg,1200,,,${signed},2026-11-19T17:06:27.000Z`,
  ]);
  assert.equal(linkExpiry("https://example.com/no-signature"), "");
});

test("without attachments, no files are listed or downloaded", async () => {
  const store = memoryStore();
  const fake = fakeClient(PAGES, FILES);
  const exporter = exporterFor(store, fake);
  await exporter.start({ includeAttachments: false });
  assert.equal(store.data.run.status, "done");
  assert.equal(fake.requested.some((r) => r.startsWith("file:")), false);
  assert.equal(await exporter.attachmentsArchive(), null);
});

test("an export stopped mid-listing resumes at the next page", async () => {
  const store = memoryStore();
  const crashing = fakeClient(PAGES, FILES);
  const list = crashing.client.listPage;
  crashing.client.listPage = async (entity, after, withFiles) => {
    if (entity.key === "jobs" && after === "1") throw new Error("worker stopped");
    return list(entity, after, withFiles);
  };
  await exporterFor(store, crashing).start({ includeAttachments: true });
  assert.equal(store.data.run.status, "error");

  const healthy = fakeClient(PAGES, FILES);
  await exporterFor(store, healthy).retry();
  assert.equal(healthy.requested[0], "jobs:1");
  assert.equal(store.data.run.status, "done");
  assert.equal(store.data.run.entities.jobs.count, 3);
});
