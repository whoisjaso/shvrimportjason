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
    (query) => (query.includes("account") ? { data: { account: { id: "A", name: "Example" } } } : { data: { jobs: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } }),
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
// lineItems: { fields, items: { [record id]: [item] }, fail: { [entity key]: page index } }
function fakeClient(pages, files = {}, lineItems = {}) {
  const requested = [];
  return {
    requested,
    client: {
      lineItemFields: async (entity) => (entity.key === "requests" ? null : (lineItems.fields ?? ["id", "name"])),
      lineItems: async (entity, after, ids) => {
        if (lineItems.fail?.[entity.key] === (after ? Number(after) : 0)) throw new RequestError("Jobber answered with an error: no line items for you");
        return Object.fromEntries(ids.map((id) => [id, lineItems.items?.[id] ?? []]));
      },
      account: async () => ({ id: "A", name: "Example Windows Co" }),
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
  assert.equal(run.company, "Example Windows Co");
  assert.deepEqual(fake.requested.filter((r) => r.startsWith("jobs:")), ["jobs:0", "jobs:1"]);
  assert.deepEqual(run.attachments, { total: 3, done: 3, listed: 4, files: 3, failed: 1, bytes: 11 });

  const { bytes: data, fileName } = await zipBytes(exporter.archive());
  assert.equal(fileName, "SHVR Export - Example Windows Co - 2026-11-16.zip");
  assert.deepEqual(unzip(data, "jobs.csv").split("\r\n").slice(0, 2), ["\uFEFFid,jobNumber,title,client.id,client.name", "J1,101,Windows,C1,Ada"]);
  assert.equal(unzip(data, "clients.csv"), "\uFEFFid,name,tags.nodes\r\nC1,Ada,\"[{\"\"label\"\":\"\"vip\"\"}]\"\r\n");

  const { bytes, fileName: attName } = await zipBytes(exporter.attachmentsArchive());
  assert.equal(attName, "SHVR Attachments - Example Windows Co - 2026-11-16.zip");
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

test("line item fields come from Jobber's schema: plain fields only", async () => {
  const scalar = (name) => ({ name, args: [], type: { kind: "SCALAR", name: "String" } });
  const types = {
    Job: [scalar("id"), { name: "lineItems", args: [{ name: "first", type: { kind: "SCALAR" } }], type: { kind: "NON_NULL", ofType: { kind: "OBJECT", name: "JobLineItemConnection" } } }],
    JobLineItemConnection: [{ name: "nodes", args: [], type: { kind: "NON_NULL", ofType: { kind: "LIST", ofType: { kind: "NON_NULL", ofType: { kind: "OBJECT", name: "JobLineItem" } } } } }],
    JobLineItem: [
      scalar("id"),
      scalar("name"),
      { name: "quantity", args: [], type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "Float" } } },
      { name: "category", args: [], type: { kind: "ENUM", name: "Category" } },
      { name: "linkedProductOrService", args: [], type: { kind: "OBJECT", name: "ProductOrService" } },
      { name: "priceIn", args: [{ name: "currency", type: { kind: "NON_NULL" } }], type: { kind: "SCALAR", name: "Float" } },
    ],
    Request: [scalar("id")],
  };
  const { fetch } = graphqlFetch((query) => ({ data: { __type: { fields: types[/__type\(name: "(\w+)"\)/.exec(query)[1]] } } }));
  const client = createJobberClient({ fetch, delayMs: 0 });
  assert.deepEqual(await client.lineItemFields(ENTITIES[0]), ["id", "name", "quantity", "category"]);
  assert.equal(await client.lineItemFields(ENTITIES[4]), null);
});

test("a page's line items come in one query; longer lists and missing records are read by id", async () => {
  const item = (n) => ({ id: `L${n}`, name: `item ${n}` });
  const { fetch, queries } = graphqlFetch((query) => {
    if (query.startsWith('{ job(id: "J1")')) return { data: { job: { lineItems: { pageInfo: { hasNextPage: false }, nodes: [item(2)] } } } };
    if (query.startsWith('{ job(id: "J3")')) return { data: { job: { lineItems: { pageInfo: { hasNextPage: false }, nodes: [item(4)] } } } };
    return {
      data: {
        jobs: {
          nodes: [
            { id: "J1", lineItems: { pageInfo: { hasNextPage: true, endCursor: "c25" }, nodes: [item(1)] } },
            { id: "J2", lineItems: { pageInfo: { hasNextPage: false }, nodes: [item(3)] } },
          ],
        },
      },
    };
  });
  const items = await createJobberClient({ fetch, delayMs: 0 }).lineItems(ENTITIES[0], "p1", ["J1", "J2", "J3"], ["id", "name"]);
  assert.deepEqual(Object.fromEntries(Object.entries(items).map(([id, list]) => [id, list.map((i) => i.id)])), { J1: ["L1", "L2"], J2: ["L3"], J3: ["L4"] });
  assert.match(queries[0], /^\{ jobs\(first: 50, after: "p1"\) \{ nodes \{ id lineItems\(first: 25\) \{ pageInfo \{ hasNextPage endCursor \} nodes \{ id name \} \} \} \} \}$/);
  assert.match(queries[1], /job\(id: "J1"\) \{ lineItems\(first: 25, after: "c25"\)/);
});

test("a line item query Jobber rejects fails even when data came back", async () => {
  const { fetch } = graphqlFetch(() => ({ data: { jobs: null }, errors: [{ message: "Field 'nope' doesn't exist" }] }));
  await assert.rejects(createJobberClient({ fetch, delayMs: 0 }).lineItems(ENTITIES[0], null, ["J1"], ["id", "nope"]), RequestError);
});

test("line items go into one CSV per record type, with a status file", async () => {
  const store = memoryStore();
  const lineItems = {
    fields: ["id", "name", "quantity", "unitPrice"],
    items: { J1: [{ id: "L1", name: "Clean windows", quantity: 2, unitPrice: 1.5 }, { id: "L2", name: "Screens", quantity: 1, unitPrice: null }], J3: [{ id: "L3", name: "Gutters", quantity: 1, unitPrice: 3 }] },
  };
  const exporter = exporterFor(store, fakeClient(PAGES, FILES, lineItems));
  await exporter.start({ includeAttachments: false });

  assert.equal(store.data.run.status, "done");
  const { bytes } = await zipBytes(exporter.archive());
  assert.deepEqual(unzip(bytes, "job_line_items.csv").replace("\uFEFF", "").trim().split("\r\n"), [
    "job_id,job_number,position,line_item_id,name,quantity,unitPrice",
    "J1,101,1,L1,Clean windows,2,1.5",
    "J1,101,2,L2,Screens,1,",
    "J3,103,1,L3,Gutters,1,3",
  ]);
  // No invoice has line items: the file still carries its header.
  assert.equal(unzip(bytes, "invoice_line_items.csv").replace("\uFEFF", "").trim(), "invoice_id,invoice_number,position,line_item_id,name,quantity,unitPrice");
  assert.deepEqual(unzip(bytes, "line_items_status.csv").replace("\uFEFF", "").trim().split("\r\n"), [
    "record_type,status,records,line_items,error",
    "job,complete,3,3,",
    "quote,complete,0,0,",
    "invoice,complete,1,0,",
  ]);
  assert.throws(() => unzip(bytes, "client_line_items.csv"));
});

test("line items that can't be read are reported, and the export still finishes", async () => {
  const store = memoryStore();
  const lineItems = { items: { J1: [{ id: "L1", name: "Clean windows" }] }, fail: { jobs: 1, invoices: 0 } };
  const exporter = exporterFor(store, fakeClient(PAGES, FILES, lineItems));
  await exporter.start({ includeAttachments: false });

  assert.equal(store.data.run.status, "done");
  assert.equal(store.data.run.entities.jobs.count, 3);
  const { bytes } = await zipBytes(exporter.archive());
  assert.deepEqual(unzip(bytes, "line_items_status.csv").replace("\uFEFF", "").trim().split("\r\n"), [
    "record_type,status,records,line_items,error",
    "job,partial,2,1,Jobber answered with an error: no line items for you",
    "quote,complete,0,0,",
    "invoice,unavailable,0,0,Jobber answered with an error: no line items for you",
  ]);
  assert.equal(unzip(bytes, "job_line_items.csv").replace("\uFEFF", "").trim().split("\r\n").length, 2);
});
