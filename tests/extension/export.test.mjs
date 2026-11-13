// node --test tests/extension
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createExporter, archiveName } from "../../extension/lib/exporter.js";
import { AuthError, RequestError, createClient } from "../../extension/lib/hcp.js";
import { MISC_COLUMNS, materialRow, miscRow, toCsv } from "../../extension/lib/rows.js";

// --- hcp client --------------------------------------------------------------

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body = {}, headers = {}, type = "basic" } = next;
    return {
      status,
      type,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[name] ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { fetch, calls };
}

function clock() {
  const state = { now: 0, slept: [] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms) => {
      state.slept.push(ms);
      state.now += ms;
    },
  };
}

test("requests are spaced, 429 waits for Retry-After, 5xx backs off", async () => {
  const time = clock();
  const { fetch, calls } = fakeFetch([
    { status: 429, headers: { "Retry-After": "3" } },
    { status: 503 },
    { body: { object: "list", data: [{ uuid: "jim_1" }] } },
    { body: { object: "list", data: [] } },
  ]);
  const client = createClient({ apiKey: "k", fetch, ...time, delayMs: 500 });

  assert.deepEqual(await client.materials("job_1"), [{ uuid: "jim_1" }]);
  assert.deepEqual(await client.miscellaneousItems("job_1"), []);
  // Retry-After 3s, then a 2s backoff; the long waits already cover the
  // spacing, so only the next job's request waits the 500ms delay.
  assert.deepEqual(time.state.slept, [3000, 2000, 500]);
  assert.equal(calls.length, 4);
  const material = new URL(calls[0].url);
  assert.equal(material.searchParams.get("job_uuid"), "job_1");
  assert.deepEqual(material.searchParams.getAll("expand[]"), ["material_vendor", "material_purchase_status", "material_source"]);
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.redirect, "manual");
});

test("a request never starts sooner than the delay after the previous one", async () => {
  const time = clock();
  const { fetch } = fakeFetch([{ body: { data: [] } }, { body: { data: [] } }, { body: { data: [] } }]);
  const client = createClient({ apiKey: "k", fetch, ...time, delayMs: 500 });
  await client.miscellaneousItems("a");
  time.state.now += 200;
  await client.miscellaneousItems("b");
  time.state.now += 900;
  await client.miscellaneousItems("c");
  assert.deepEqual(time.state.slept, [300]);
});

test("signed-out browser and rejected key are told apart", async () => {
  const redirect = fakeFetch([{ status: 0, type: "opaqueredirect" }]);
  await assert.rejects(createClient({ fetch: redirect.fetch, delayMs: 0 }).checkSession(), (error) => error instanceof AuthError && error.kind === "session");

  const html = fakeFetch([{ body: "<html>Log in</html>" }]);
  await assert.rejects(createClient({ fetch: html.fetch, delayMs: 0 }).checkSession(), (error) => error.kind === "session");

  const key = fakeFetch([{ status: 401 }]);
  await assert.rejects(createClient({ apiKey: "bad", fetch: key.fetch, delayMs: 0 }).company(), (error) => error.kind === "api_key");
  assert.equal(key.calls[0].init.headers.Authorization, "Token bad");
});

// --- rows and files ----------------------------------------------------------

test("cost rows convert cents to dollars and multiply quantity", () => {
  const material = materialRow("job_a", "1001", {
    uuid: "jim_1",
    name: "Paint",
    quantity: "2.5",
    unit_cost: 4599,
    material_vendor: { object: "material_vendor", data: { uuid: "matv_1", name: "Sherwin" } },
    material_source: "Store",
  });
  assert.equal(material.unit_cost, "45.99");
  assert.equal(material.total_cost, "114.98");
  assert.equal(material.vendor, "Sherwin");
  assert.equal(material.vendor_uuid, "matv_1");
  assert.equal(material.material_source, "Store");

  const misc = miscRow("job_a", "1001", { uuid: "mcli_1", unit_cost: 25000, qty_in_hundredths: 150, quantity: 1.5 });
  assert.deepEqual([misc.quantity, misc.unit_cost, misc.total_cost], ["1.5", "250.00", "375.00"]);
});

test("CSV quotes awkward cells and starts with a BOM for Excel", () => {
  const csv = toCsv(["a", "b"], [{ a: 'Say "hi", ok', b: "line\nbreak" }, { a: null }]);
  assert.equal(csv, '\uFEFFa,b\r\n"Say ""hi"", ok","line\nbreak"\r\n,\r\n');
});

// --- exporter ----------------------------------------------------------------

function memoryStore(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const list = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete data[key];
    },
  };
}

const JOBS = [
  { id: "job_a", invoice_number: "1001", customer: { first_name: "Ada", last_name: "Lovelace" }, subtotal: 123456 },
  { id: "job_b", invoice_number: "1002" },
  { id: "job_c", invoice_number: "1003" },
];

function fakeClient({ costFailures = {}, pages = [JOBS.slice(0, 2), JOBS.slice(2)], session = true } = {}) {
  const fetched = [];
  return {
    fetched,
    client: {
      company: async () => ({ id: "org_1", name: "T1P Richmond" }),
      checkSession: async () => {
        if (!session) throw new AuthError("session", "signed out");
      },
      jobsPage: async (page) => ({ jobs: pages[page - 1] ?? [], totalPages: pages.length }),
      materials: async (jobId) => {
        fetched.push(jobId);
        const failure = costFailures[jobId];
        if (failure) throw failure;
        return jobId === "job_a" ? [{ uuid: "jim_1", name: "Paint", quantity: "1.0", unit_cost: 350 }] : [];
      },
      miscellaneousItems: async (jobId) => (jobId === "job_b" ? [{ uuid: "mcli_1", name: "Sub", unit_cost: 4000, quantity: 1 }] : []),
    },
  };
}

function exporterFor(store, fake, onFinished = async () => {}) {
  return createExporter({ store, makeClient: () => fake.client, now: () => Date.UTC(2026, 10, 12, 15), onFinished });
}

function unzip(bytes, member) {
  const dir = mkdtempSync(join(tmpdir(), "hcp-export-"));
  const path = join(dir, "out.zip");
  writeFileSync(path, bytes);
  return execFileSync("unzip", ["-p", path, member], { encoding: "utf8" });
}

test("a full export lists every page, links costs to jobs, and zips three CSVs", async () => {
  const store = memoryStore({ apiKey: "k" });
  const fake = fakeClient();
  let finishedRun = null;
  const exporter = exporterFor(store, fake, async (run) => {
    finishedRun = run;
  });

  await exporter.start();

  assert.equal(finishedRun.status, "done");
  assert.equal(finishedRun.total, 3);
  assert.equal(finishedRun.done, 3);
  assert.equal(finishedRun.company, "T1P Richmond");

  const { bytes, fileName } = await exporter.archive();
  assert.equal(fileName, "HCP Job Costing Export - T1P Richmond - 2026-11-12.zip");
  const jobs = unzip(bytes, "jobs.csv").split("\r\n");
  assert.match(jobs[1], /^job_a,1001,,,,Ada Lovelace,/);
  assert.equal(jobs.length, 5); // header, 3 jobs, trailing newline
  assert.equal(unzip(bytes, "materials.csv").split("\r\n")[1].split(",").slice(0, 3).join(","), "job_a,1001,jim_1");
  assert.equal(unzip(bytes, "miscellaneous_items.csv"), `\uFEFF${MISC_COLUMNS.join(",")}\r\njob_b,1002,mcli_1,Sub,,1,40.00,40.00\r\n`);
});

test("an interrupted export resumes without refetching finished jobs", async () => {
  const store = memoryStore({ apiKey: "k" });
  const crashing = fakeClient({ costFailures: { job_b: new Error("worker stopped") } });
  await exporterFor(store, crashing).start();
  assert.equal(store.data.run.status, "error");
  assert.equal(store.data.run.done, 1);

  // The worker restarts and the run is marked active again by retry().
  const healthy = fakeClient();
  await exporterFor(store, healthy).retry();
  assert.deepEqual(healthy.fetched, ["job_b", "job_c"]);
  assert.equal(store.data.run.status, "done");
  assert.equal(store.data.run.done, 3);
});

test("a job that keeps failing is skipped, reported, and retried alone", async () => {
  const store = memoryStore({ apiKey: "k" });
  await exporterFor(store, fakeClient({ costFailures: { job_b: new RequestError("HTTP 500", 500) } })).start();
  assert.equal(store.data.run.status, "done");
  assert.deepEqual(store.data.run.failed.map((job) => [job.job_id, job.invoice_number]), [["job_b", "1002"]]);

  const healthy = fakeClient();
  await exporterFor(store, healthy).retry();
  assert.deepEqual(healthy.fetched, ["job_b"]);
  assert.deepEqual(store.data.run.failed, []);
});

test("the first job refused outright means the browser is in another company", async () => {
  const store = memoryStore({ apiKey: "k" });
  await exporterFor(store, fakeClient({ costFailures: { job_a: new RequestError("HTTP 404", 404) } })).start();
  assert.equal(store.data.run.status, "error");
  assert.equal(store.data.run.error.kind, "wrong_company");
});

test("signed-out browser stops before any job is read", async () => {
  const store = memoryStore({ apiKey: "k" });
  const fake = fakeClient({ session: false });
  await exporterFor(store, fake).start();
  assert.equal(store.data.run.error.kind, "session");
  assert.deepEqual(fake.fetched, []);
});

test("starting again drops the previous run's costs", async () => {
  const store = memoryStore({ apiKey: "k" });
  await exporterFor(store, fakeClient()).start();
  const second = fakeClient({ pages: [[JOBS[1]]] });
  await exporterFor(store, second).start();
  assert.deepEqual(second.fetched, ["job_b"]);
  assert.equal("cost:job_a" in store.data, false);
});

test("archive names stay valid file names", () => {
  assert.equal(archiveName('A/B: "Painters"', new Date(2026, 0, 5)), "HCP Job Costing Export - A B Painters - 2026-01-05.zip");
  assert.equal(archiveName("", new Date(2026, 0, 5)), "HCP Job Costing Export - 2026-01-05.zip");
});
