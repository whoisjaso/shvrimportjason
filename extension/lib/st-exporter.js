// The ServiceTitan export run, in two phases. Everything is saved as it
// arrives, so a stopped worker resumes where it left off:
//
//   listing      page through each search (jobs, estimates, customers,
//                invoices, leads, payments), keeping every record whole
//   attachments  only when the user asked for them: for every job (and every
//                estimate without a job), list its files and measurement
//                reports, and download each file once, many at a time
//
// Storage (chrome.storage.local):
//   run                 status and counters; run.provider is "servicetitan"
//   st:<entity>:<page>  raw records from one search page
//   statt:<unit key>    attachment rows of one finished job ("job:<id>") or
//                       job-less estimate ("estimate:<id>")
// Files (IndexedDB, see blobs.js): "att:<unit key>:<n>" -> Blob

import { AuthError, RequestError } from "./hcp.js";
import { ACTIVE, clearRun, archiveName } from "./exporter.js";
import { columnsOf, flatten } from "./flatten.js";
import { ENTITIES, JOB_ATTACHMENT_LIMIT, recordId } from "./servicetitan.js";
import { toCsv } from "./rows.js";
import { crc32, zipParts } from "./zip.js";

const MAX_PAGES = 5000;
// Downloads are latency-bound (~600ms each, one at a time). Measured live
// 2026-11-13: throughput grows with parallel downloads up to about 32, with
// no 429s or errors at 64.
export const DOWNLOAD_CONCURRENCY = 32;
// Jobs listed at once, so the download slots stay full when jobs are small.
const UNIT_CONCURRENCY = 4;
// At most one progress write per this many ms while downloading.
const PROGRESS_MS = 500;
const pageKey = (entity, page) => `st:${entity}:${page}`;
const attKey = (unitKey) => `statt:${unitKey}`;

export const ATTACHMENT_COLUMNS = [
  "kind",
  "category",
  "job_id",
  "job_number",
  "estimate_id",
  "file_name",
  "zip_path",
  "content_type",
  "size_bytes",
  "status",
  "error",
  "file_ref",
];

// makeClient(host, { onWait }) -> client from servicetitan.js
// files: { put(key, bytes, type), get(key) -> Blob, clear() }
export function createServiceTitanExporter({ store, files, makeClient, now = () => Date.now(), onFinished = async () => {} }) {
  let running = null;
  let cancelRequested = false;

  async function readRun() {
    return (await store.get("run")).run ?? null;
  }

  async function writeRun(run, extra = {}) {
    await store.set({ run, ...extra });
    return run;
  }

  async function records(entityKey, run) {
    const keys = Array.from({ length: run.entities[entityKey].pages }, (_, i) => pageKey(entityKey, i + 1));
    const pages = keys.length ? await store.get(keys) : {};
    return keys.flatMap((key) => pages[key] ?? []);
  }

  async function unitsOf(run) {
    return attachmentUnits(await records("jobs", run), await records("estimates", run));
  }

  async function work() {
    let run = await readRun();
    const client = makeClient(run.host, {
      onWait: ({ reason, seconds }) => {
        run = { ...run, notice: { reason, until: now() + seconds * 1000 } };
        store.set({ run });
      },
    });
    const canceled = () => writeRun({ ...run, status: "canceled", notice: null });

    try {
      if (!run.sessionChecked) {
        await client.checkSession();
        run = await writeRun({ ...run, sessionChecked: true });
      }

      if (run.status === "listing") {
        for (const entity of ENTITIES) {
          const progress = run.entities[entity.key];
          if (progress.done) continue;
          // Ids already saved, to stop if the server repeats a page.
          const seen = new Set();
          for (const record of await records(entity.key, run)) seen.add(recordId(record));

          for (let page = progress.pages + 1; page <= MAX_PAGES; page += 1) {
            if (cancelRequested) return await canceled();
            run = await writeRun({ ...run, current: entity.key, notice: null });
            const { records: batch, total } = await client.searchPage(entity.search, page);
            const fresh = batch.filter((record) => !seen.has(recordId(record)));
            for (const record of fresh) seen.add(recordId(record));

            const count = progress.count + fresh.length;
            const finished = fresh.length === 0 || (total !== null && count >= total);
            Object.assign(progress, { pages: fresh.length ? page : progress.pages, count, total, done: finished });
            run = { ...run, entities: { ...run.entities, [entity.key]: { ...progress } } };
            await writeRun(run, fresh.length ? { [pageKey(entity.key, page)]: fresh } : {});
            if (finished) break;
          }
        }
        if (run.includeAttachments) {
          const total = (await unitsOf(run)).length;
          run = await writeRun({ ...run, status: "attachments", current: null, attachments: { total, done: 0, files: 0, failed: 0, skipped: 0, bytes: 0 } });
        }
      }

      if (run.status === "attachments") {
        run = await fetchAttachments();
        if (run.status !== "attachments") return run;
      }

      run = await writeRun({ ...run, status: "done", current: null, finishedAt: now(), notice: null });
      await onFinished(run);
      return run;
    } catch (error) {
      const kind = error instanceof AuthError ? error.kind : "other";
      return await writeRun({ ...run, status: "error", notice: null, error: { kind, message: error.message } });
    }

    // Jobs (and job-less estimates) run UNIT_CONCURRENCY at a time; their
    // downloads share DOWNLOAD_CONCURRENCY slots. A unit's rows are saved
    // only once every one of its files has finished, so a resumed run
    // repeats just the units that were in progress.
    async function fetchAttachments() {
      const units = await unitsOf(run);
      const saved = units.length ? await store.get(units.map((unit) => attKey(unit.key))) : {};
      const seenRefs = new Set();
      const usedPaths = new Set();
      const totals = { total: units.length, done: 0, files: 0, failed: 0, skipped: 0, bytes: 0 };
      for (const rows of Object.values(saved)) {
        totals.done += 1;
        for (const row of rows) {
          seenRefs.add(row.file_ref);
          if (row.zip_path) usedPaths.add(row.zip_path);
          if (row.status === "saved") {
            totals.files += 1;
            totals.bytes += Number(row.size_bytes) || 0;
          } else if (row.status === "failed") totals.failed += 1;
          else if (row.status === "skipped") totals.skipped += 1;
        }
      }

      // null while running; "cancel", or the error that stops the run. Any
      // stop starts no new job; a cancel or sign-out also drops the queued
      // downloads, while other errors let jobs already started finish.
      let stop = null;
      const halt = (reason) => {
        stop ??= reason;
      };
      const aborted = () => stop === "cancel" || stop instanceof AuthError;
      const download = limiter(DOWNLOAD_CONCURRENCY);
      let lastWrite = 0;
      let preview = run.preview;
      run = { ...run, attachments: { ...totals }, notice: null };

      const progress = async (force, extra = {}) => {
        if (!force && now() - lastWrite < PROGRESS_MS) return;
        lastWrite = now();
        run = { ...run, attachments: { ...totals }, preview };
        await writeRun(run, extra);
      };

      async function fetchUnit(unit) {
        run = { ...run, current: unit.label };
        await progress(true);
        // A job ServiceTitan can't list (a 500 for a deleted job, say) gets
        // one failed row; it shouldn't stop the other jobs, and retrying
        // the run would only hit it again.
        let listed;
        const notes = [];
        try {
          if (unit.kind === "job") {
            const documents = await client.jobAttachments(unit.jobId);
            if (documents.length >= JOB_ATTACHMENT_LIMIT) {
              notes.push(`ServiceTitan listed ${JOB_ATTACHMENT_LIMIT} files, its most per request; this job may have more that aren't here.`);
            }
            listed = [
              ...documents.map((meta) => ({ kind: "document", meta })),
              ...(await client.jobMeasurements(unit.jobId)).map((meta) => ({ kind: "measurement", meta })),
            ];
          } else {
            listed = [
              ...(await client.estimateDocuments(unit.estimateId)).map((meta) => ({ kind: "document", meta })),
              ...(await client.estimateMeasurements(unit.estimateId)).map((meta) => ({ kind: "measurement", meta })),
            ];
          }
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          listed = [];
          notes.push(`Couldn't list this ${unit.kind}'s attachments: ${error.message}`);
        }
        if (aborted()) return;

        // Claimed before any await, so units running side by side never
        // fetch the same file or write the same zip path.
        const rows = [];
        const wanted = [];
        for (const { kind, meta } of listed) {
          if (seenRefs.has(meta.fileRef)) continue;
          seenRefs.add(meta.fileRef);
          const row = baseRow(kind, meta, unit);
          if (isCatalogImage(kind, meta)) {
            // Pricebook and supplier product photos: listed, never downloaded.
            Object.assign(row, { file_name: safeName(meta.originalFilename || lastSegment(meta.fileRef)), status: "skipped", error: "Catalog image (pricebook or supplier product photo)" });
            totals.skipped += 1;
          } else {
            const fileName = safeName(meta.originalFilename || lastSegment(meta.fileRef) || `file ${rows.length + 1}`);
            const zipPath = uniquePath(`${unit.folder}/${kind === "document" ? "documents" : "measurements"}/${fileName}`, usedPaths);
            Object.assign(row, { file_name: fileName, zip_path: zipPath, blob_key: `att:${unit.key}:${rows.length}` });
            wanted.push(row);
          }
          rows.push(row);
        }
        for (const note of notes) {
          rows.push({ ...baseRow("listing", { fileRef: "" }, unit), category: "listing", status: "failed", error: note });
          totals.failed += 1;
        }

        await Promise.all(
          wanted.map((row) =>
            download(async () => {
              if (aborted()) return;
              try {
                const file = await client.download(row.file_ref);
                await files.put(row.blob_key, file.bytes, file.type);
                Object.assign(row, { content_type: file.type, size_bytes: String(file.bytes.length), status: "saved", crc: crc32(file.bytes) });
                totals.files += 1;
                totals.bytes += file.bytes.length;
                if (isImage(file.type, row.file_name)) preview = { key: row.blob_key, name: row.file_name, jobNumber: unit.jobNumber };
              } catch (error) {
                // Sign-out, storage failure: the job isn't saved, and the run stops.
                if (!(error instanceof RequestError)) throw error;
                Object.assign(row, { status: "failed", error: error.message });
                totals.failed += 1;
              }
              if (cancelRequested) halt("cancel");
              await progress(false);
            }),
          ),
        );
        if (aborted()) return;
        totals.done += 1;
        await progress(true, { [attKey(unit.key)]: rows });
      }

      const pending = units.filter((unit) => !saved[attKey(unit.key)]);
      await Promise.all(
        Array.from({ length: UNIT_CONCURRENCY }, async () => {
          while (!stop && pending.length) {
            if (cancelRequested) return halt("cancel");
            await fetchUnit(pending.shift()).catch(halt);
          }
        }),
      );
      if (stop === "cancel") return await canceled();
      if (stop) throw stop;
      run = { ...run, attachments: { ...totals }, preview, current: null };
      return run;
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

  async function attachmentRows(run) {
    const units = await unitsOf(run);
    const saved = units.length ? await store.get(units.map((unit) => attKey(unit.key))) : {};
    return units.flatMap((unit) => saved[attKey(unit.key)] ?? []);
  }

  return {
    isRunning: () => running !== null,

    async start({ tenant, host, includeAttachments = true }) {
      if (running) return running;
      await clearRun(store);
      await files.clear();
      const entities = Object.fromEntries(ENTITIES.map((entity) => [entity.key, { pages: 0, count: 0, total: null, done: false }]));
      await writeRun({ provider: "servicetitan", status: "listing", startedAt: now(), company: tenant, tenant, host, includeAttachments, entities, current: null });
      return launch();
    },

    async resume() {
      if (running) return running;
      const run = await readRun();
      if (!run || !ACTIVE.has(run.status)) return run;
      return launch();
    },

    // Pick up after an error at the page or job that failed.
    async retry() {
      if (running) return running;
      const run = await readRun();
      if (!run) return null;
      const status = run.attachments ? "attachments" : "listing";
      await writeRun({ ...run, status, error: null, notice: null, sessionChecked: false });
      return launch();
    },

    cancel() {
      cancelRequested = true;
    },

    // The data zip as parts for `new Blob(parts)`: one CSV per search with
    // every field.
    async archive() {
      const run = await readRun();
      const entries = [];
      for (const entity of ENTITIES) {
        const rows = (await records(entity.key, run)).map((record) => flatten(record));
        entries.push({ name: `${entity.key}.csv`, data: toCsv(columnsOf(rows), rows) });
      }
      const stamp = new Date(run.finishedAt ?? now());
      return { parts: zipParts(entries, stamp), fileName: archiveName(run.tenant, stamp) };
    },

    // The attachments zip: attachments.csv (one row per file found, with
    // its zip_path) and a folder per job. null when the run skipped them.
    async attachmentsArchive() {
      const run = await readRun();
      if (!run.attachments) return null;
      const attachments = await attachmentRows(run);
      const csvRows = attachments.map(({ info, blob_key: _key, crc: _crc, ...row }) => ({ ...row, ...prefixed(info) }));
      const entries = [
        { name: "attachments.csv", data: toCsv([...ATTACHMENT_COLUMNS, ...columnsOf(csvRows).filter((c) => !ATTACHMENT_COLUMNS.includes(c))], csvRows) },
      ];
      for (const row of attachments) {
        if (row.status !== "saved") continue;
        const blob = await files.get(row.blob_key);
        if (blob) entries.push({ name: row.zip_path, blob, crc: row.crc, size: blob.size });
      }
      const stamp = new Date(run.finishedAt ?? now());
      return { parts: zipParts(entries, stamp), fileName: archiveName(run.tenant, stamp, "SHVR Attachments") };
    },
  };
}

// What to fetch attachments for: every job, plus estimates with no job
// (their sales record's files are reachable only through the estimate).
// An estimate's job missing from the job search still gets a job unit.
export function attachmentUnits(jobs, estimates) {
  const units = new Map();
  const addJob = (id, number) => {
    if (!id || units.has(`job:${id}`)) return;
    const jobNumber = number || id;
    units.set(`job:${id}`, { key: `job:${id}`, kind: "job", jobId: id, jobNumber, estimateId: "", label: `job ${jobNumber}`, folder: safeName(`job ${jobNumber}`) });
  };
  for (const job of jobs) addJob(String(job.Id ?? ""), String(job.JobNumber ?? job.Number ?? ""));
  for (const estimate of estimates) if (estimate.JobId) addJob(String(estimate.JobId), String(estimate.JobNumber ?? ""));
  for (const estimate of estimates) {
    const id = String(estimate.Id ?? "");
    if (id && !estimate.JobId) units.set(`estimate:${id}`, { key: `estimate:${id}`, kind: "estimate", jobId: "", jobNumber: "", estimateId: id, label: `estimate ${id}`, folder: safeName(`estimate ${id}`) });
  }
  return [...units.values()];
}

// Runs at most `max` of the given async functions at once.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

function prefixed(info = {}) {
  return Object.fromEntries(Object.entries(info).map(([key, value]) => [`info.${key}`, value]));
}

function lastSegment(ref) {
  return String(ref ?? "").split("/").filter(Boolean).pop() ?? "";
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|avi|webm|3gp|mkv)$/i;

// ServiceTitan labels some photos "unknown/unknown", so fall back to the name.
function isImage(type, name) {
  return /^image\/(jpeg|png|gif|webp|bmp|avif)/i.test(type) || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(name);
}

// Safe on Windows and macOS; keeps the extension.
export function safeName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ ]+$/g, "")
    .slice(0, 150);
  return cleaned || "file";
}

function uniquePath(path, used) {
  let candidate = path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 2; used.has(candidate); n += 1) candidate = `${stem} (${n})${ext}`;
  used.add(candidate);
  return candidate;
}

// Attachment categories, from what ServiceTitan says a document belongs to
// (ownerType: 1 job, 5 the sales record above an unbooked estimate, 8 a
// pricebook item) and what kind of file it is (type: 1 image, 2 video,
// 3 document; the per-job listing has no type, so the extension decides).
export function categoryOf(kind, meta) {
  if (kind === "measurement") return "measurement";
  if (isCatalogImage(kind, meta)) return "catalog image";
  const name = meta.originalFilename || meta.fileRef || "";
  const what = { 1: "photo", 2: "video", 3: "document" }[meta.type] ?? (IMAGE_EXT.test(name) ? "photo" : VIDEO_EXT.test(name) ? "video" : "document");
  if (meta.ownerType === 1) return `job ${what}`;
  if (meta.ownerType === 5) return `sales ${what}`;
  return what;
}

// Pricebook and supplier catalog images all live under Images/ (job uploads
// live under Attaches/, text-message media under Messages/Media/), including
// product photos copied onto a job.
function isCatalogImage(kind, meta) {
  return kind === "document" && (String(meta.fileRef).startsWith("Images/") || meta.ownerType === 8);
}

function baseRow(kind, meta, unit) {
  return {
    kind,
    category: categoryOf(kind, meta),
    job_id: unit.jobId,
    job_number: unit.jobNumber,
    estimate_id: unit.estimateId,
    file_name: "",
    zip_path: "",
    content_type: "",
    size_bytes: "",
    status: "",
    error: "",
    file_ref: meta.fileRef,
    info: flatten(meta),
  };
}
