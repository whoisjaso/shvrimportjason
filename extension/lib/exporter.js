// The export run: list every job and estimate, then fetch each job's costs
// one at a time. Progress lives in storage under these keys, so the run
// survives the service worker being stopped and picks up where it left off:
//
//   run              status and counters the app page renders
//   jobs             job rows, in Housecall Pro's order
//   estimates        estimate rows
//   estimateOptions  estimate option rows
//   cost:<id>        { materials, misc } rows for one finished job

import { AuthError, JOBS_PAGE_SIZE, RequestError } from "./hcp.js";
import {
  ESTIMATE_COLUMNS,
  ESTIMATE_OPTION_COLUMNS,
  JOB_COLUMNS,
  MATERIAL_COLUMNS,
  MISC_COLUMNS,
  estimateOptionRows,
  estimateRow,
  jobRow,
  materialRow,
  miscRow,
  toCsv,
} from "./rows.js";
import { makeZip } from "./zip.js";

// Statuses of a run that's still going, for either provider.
export const ACTIVE = new Set(["listing", "costs", "attachments"]);
const COST_PREFIX = "cost:";

// Settings that outlive an export; everything else in storage is run data.
const SETTINGS = new Set(["apiKey", "company", "provider", "stTenant", "includeAttachments", "linksOnly"]);

export async function clearRun(store) {
  const keys = Object.keys(await store.get(null)).filter((key) => !SETTINGS.has(key));
  if (keys.length) await store.remove(keys);
}

// store: { get(keys) -> object, set(object), remove(keys) } (chrome.storage.local's shape)
// makeClient(apiKey, { onWait }) -> client from hcp.js
export function createExporter({ store, makeClient, now = () => Date.now(), onFinished = async () => {} }) {
  let running = null;
  let cancelRequested = false;

  async function readRun() {
    return (await store.get("run")).run ?? null;
  }

  async function writeRun(run, extra = {}) {
    await store.set({ run, ...extra });
    return run;
  }

  async function clearRunData() {
    await clearRun(store);
  }

  async function work() {
    let run = await readRun();
    const { apiKey } = await store.get("apiKey");
    const client = makeClient(apiKey, {
      onWait: ({ reason, seconds }) => {
        run = { ...run, notice: { reason, until: now() + seconds * 1000 } };
        store.set({ run });
      },
    });

    // Every record of "jobs" or "estimates", page by page; null when canceled.
    async function listAll(resource) {
      const records = [];
      for (let page = 1; ; page += 1) {
        const { records: batch, totalPages } = await client.listPage(resource, page);
        records.push(...batch);
        run = await writeRun({ ...run, listing: resource, page, totalPages, notice: null });
        if (cancelRequested) return null;
        if (!batch.length) return records;
        if (totalPages !== null ? page >= totalPages : batch.length < JOBS_PAGE_SIZE) return records;
      }
    }

    try {
      if (run.status === "listing") {
        const company = await client.company();
        run = await writeRun({ ...run, company: company.name || company.business_name || "" });
        await client.checkSession();

        const jobRecords = await listAll("jobs");
        if (!jobRecords) return await writeRun({ ...run, status: "canceled" });
        const estimateRecords = await listAll("estimates");
        if (!estimateRecords) return await writeRun({ ...run, status: "canceled" });

        const jobs = jobRecords.map(jobRow).filter((job) => job.job_id);
        const estimates = estimateRecords.map(estimateRow).filter((estimate) => estimate.estimate_id);
        const estimateOptions = estimateRecords.flatMap(estimateOptionRows);
        run = { ...run, status: "costs", total: jobs.length, estimates: estimates.length, done: 0, failed: [] };
        await writeRun(run, { jobs, estimates, estimateOptions });
      }

      const { jobs } = await store.get("jobs");
      const finished = await store.get(jobs.map((job) => COST_PREFIX + job.job_id));
      const pending = jobs.filter((job) => !finished[COST_PREFIX + job.job_id]);
      let done = jobs.length - pending.length;
      run = await writeRun({ ...run, done, pace: { at: now(), done } });

      for (const job of pending) {
        if (cancelRequested) return await writeRun({ ...run, status: "canceled", notice: null });
        let materials;
        let misc;
        try {
          materials = await client.materials(job.job_id);
          misc = await client.miscellaneousItems(job.job_id);
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          // The first job of the company refused outright: the browser is
          // signed in to a different Housecall Pro company than the key.
          if (done === 0 && run.failed.length === 0 && [403, 404].includes(error.status)) {
            return await writeRun({
              ...run,
              status: "error",
              notice: null,
              error: { kind: "wrong_company", message: error.message },
            });
          }
          run = await writeRun({
            ...run,
            notice: null,
            failed: [...run.failed, { job_id: job.job_id, invoice_number: job.invoice_number, message: error.message }],
          });
          continue;
        }
        done += 1;
        run = { ...run, done, notice: null };
        await writeRun(run, {
          [COST_PREFIX + job.job_id]: {
            materials: materials.map((material) => materialRow(job.job_id, job.invoice_number, material)),
            misc: misc.map((item) => miscRow(job.job_id, job.invoice_number, item)),
          },
        });
      }

      run = await writeRun({ ...run, status: "done", finishedAt: now(), notice: null });
      await onFinished(run);
      return run;
    } catch (error) {
      const kind = error instanceof AuthError ? error.kind : "other";
      return await writeRun({ ...run, status: "error", notice: null, error: { kind, message: error.message } });
    }
  }

  function launch() {
    if (!running) {
      cancelRequested = false;
      running = work().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return {
    isRunning: () => running !== null,

    // A brand-new export; anything from an earlier run is dropped.
    async start() {
      if (running) return running;
      await clearRunData();
      await writeRun({ provider: "hcp", status: "listing", startedAt: now(), company: "", page: 0, totalPages: null, total: 0, done: 0, failed: [] });
      return launch();
    },

    // Continue an export that stopped part-way (worker restarted, browser closed).
    async resume() {
      if (running) return running;
      const run = await readRun();
      if (!run || !ACTIVE.has(run.status)) return run;
      return launch();
    },

    // Fetch again only the jobs that failed, or everything left after an error.
    async retry() {
      if (running) return running;
      const run = await readRun();
      if (!run) return null;
      const { jobs } = await store.get("jobs");
      const status = jobs ? "costs" : "listing";
      await writeRun({ ...run, status, failed: [], error: null, notice: null });
      return launch();
    },

    cancel() {
      cancelRequested = true;
    },

    // The finished export as one zip: { bytes, fileName }.
    async archive() {
      const run = await readRun();
      const { jobs, estimates = [], estimateOptions = [] } = await store.get(["jobs", "estimates", "estimateOptions"]);
      const costs = await store.get(jobs.map((job) => COST_PREFIX + job.job_id));
      const finished = jobs.map((job) => costs[COST_PREFIX + job.job_id]).filter(Boolean);
      const stamp = new Date(run.finishedAt ?? now());
      const bytes = makeZip(
        [
          { name: "jobs.csv", data: toCsv(JOB_COLUMNS, jobs) },
          { name: "materials.csv", data: toCsv(MATERIAL_COLUMNS, finished.flatMap((cost) => cost.materials)) },
          { name: "miscellaneous_items.csv", data: toCsv(MISC_COLUMNS, finished.flatMap((cost) => cost.misc)) },
          { name: "estimates.csv", data: toCsv(ESTIMATE_COLUMNS, estimates) },
          { name: "estimate_options.csv", data: toCsv(ESTIMATE_OPTION_COLUMNS, estimateOptions) },
        ],
        stamp,
      );
      return { bytes, fileName: archiveName(run.company, stamp) };
    },
  };
}

export function archiveName(company, date, title = "SHVR Export") {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  const who = String(company || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${title}${who ? ` - ${who}` : ""} - ${day}.zip`;
}
