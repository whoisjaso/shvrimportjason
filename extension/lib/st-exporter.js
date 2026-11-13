// The ServiceTitan export run, in two phases. Everything is saved as it
// arrives, so a stopped worker resumes where it left off:
//
//   listing      page through each search (jobs, estimates, customers,
//                invoices, leads, payments), keeping every record whole
//   attachments  for every estimate, list its job's documents and its
//                location's measurements, and download each file once
//
// Storage (chrome.storage.local):
//   run                 status and counters; run.provider is "servicetitan"
//   st:<entity>:<page>  raw records from one search page
//   statt:<estimateId>  attachment rows first found through that estimate
// Files (IndexedDB, see blobs.js): "att:<n>" -> Blob

import { AuthError, RequestError } from "./hcp.js";
import { ACTIVE, clearRun, archiveName } from "./exporter.js";
import { columnsOf, flatten } from "./flatten.js";
import { ENTITIES, recordId } from "./servicetitan.js";
import { toCsv } from "./rows.js";
import { crc32, zipParts } from "./zip.js";

const MAX_PAGES = 5000;
const pageKey = (entity, page) => `st:${entity}:${page}`;
const attKey = (estimateId) => `statt:${estimateId}`;

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
        const estimateIds = (await records("estimates", run)).map((record) => String(record.Id ?? "")).filter(Boolean);
        run = { ...run, status: "attachments", current: null, attachments: { total: estimateIds.length, done: 0, files: 0, failed: 0, skipped: 0, bytes: 0 } };
        await writeRun(run);
      }

      if (run.status === "attachments") run = await fetchAttachments(run, client);
      if (run.status !== "attachments") return run;

      run = await writeRun({ ...run, status: "done", current: null, finishedAt: now(), notice: null });
      await onFinished(run);
      return run;
    } catch (error) {
      const kind = error instanceof AuthError ? error.kind : "other";
      return await writeRun({ ...run, status: "error", notice: null, error: { kind, message: error.message } });
    }

    async function fetchAttachments(current, client) {
      run = current;
      const estimates = await records("estimates", run);
      const jobNumbers = new Map((await records("jobs", run)).map((job) => [String(job.Id), String(job.JobNumber ?? job.Number ?? "")]));
      const ids = estimates.map((estimate) => String(estimate.Id ?? "")).filter(Boolean);

      // Rebuild what earlier sessions of this run already saved.
      const saved = ids.length ? await store.get(ids.map(attKey)) : {};
      const seenRefs = new Set();
      const usedPaths = new Set();
      let fileIndex = 0;
      for (const rows of Object.values(saved)) {
        for (const row of rows) {
          seenRefs.add(row.file_ref);
          usedPaths.add(row.zip_path);
          fileIndex += 1;
        }
      }

      for (const estimate of estimates) {
        const estimateId = String(estimate.Id ?? "");
        if (!estimateId || saved[attKey(estimateId)]) continue;
        if (cancelRequested) return await canceled();

        const jobId = estimate.JobId ? String(estimate.JobId) : "";
        const jobNumber = (jobId && jobNumbers.get(jobId)) || String(estimate.JobNumber ?? "") || jobId;
        // step: what's happening inside the current estimate, for the page.
        // Its counters cover only this estimate; run.attachments holds the
        // totals of finished estimates.
        let step = { estimateId, jobNumber, phase: "listing", index: 0, count: 0, fileName: "", files: 0, failed: 0, skipped: 0, bytes: 0 };
        run = await writeRun({ ...run, current: estimateId, step, notice: null });

        const folder = `attachments/${safeName(jobNumber ? `job ${jobNumber}` : `estimate ${estimateId}`)}`;
        const listed = [
          ...(await client.documents(estimateId)).map((meta) => ({ kind: "document", meta })),
          ...(await client.measurements(estimateId)).map((meta) => ({ kind: "measurement", meta })),
        ].filter(({ meta }) => !seenRefs.has(meta.fileRef) && seenRefs.add(meta.fileRef));
        // Pricebook and supplier product photos ride along with every estimate
        // that uses the item; they're listed in the CSV but never downloaded.
        const wanted = listed.filter(({ kind, meta }) => !isCatalogImage(kind, meta));
        const rows = listed
          .filter((entry) => !wanted.includes(entry))
          .map(({ kind, meta }) => ({
            ...baseRow(kind, meta, { jobId, jobNumber, estimateId }),
            file_name: safeName(meta.originalFilename || lastSegment(meta.fileRef)),
            status: "skipped",
            error: "Catalog image (pricebook or supplier product photo)",
          }));
        step = { ...step, phase: "downloading", count: wanted.length, skipped: rows.length };
        run = await writeRun({ ...run, step });

        for (const [position, { kind, meta }] of wanted.entries()) {
          if (cancelRequested) return await canceled();
          const fileName = safeName(meta.originalFilename || lastSegment(meta.fileRef) || `file ${fileIndex + 1}`);
          const zipPath = uniquePath(`${folder}/${kind === "document" ? "documents" : "measurements"}/${fileName}`, usedPaths);
          step = { ...step, index: position + 1, fileName };
          run = await writeRun({ ...run, step });
          const row = { ...baseRow(kind, meta, { jobId, jobNumber, estimateId }), file_name: fileName, zip_path: zipPath };
          let preview = run.preview;
          try {
            const file = await client.download(meta.fileRef);
            const blobKey = `att:${fileIndex}`;
            await files.put(blobKey, file.bytes, file.type);
            Object.assign(row, { content_type: file.type, size_bytes: String(file.bytes.length), status: "saved", blob_key: blobKey, crc: crc32(file.bytes) });
            step = { ...step, files: step.files + 1, bytes: step.bytes + file.bytes.length };
            if (isImage(file.type, fileName)) preview = { key: blobKey, name: fileName, jobNumber };
          } catch (error) {
            if (!(error instanceof RequestError)) throw error;
            Object.assign(row, { status: "failed", error: error.message });
            step = { ...step, failed: step.failed + 1 };
          }
          fileIndex += 1;
          rows.push(row);
          run = await writeRun({ ...run, step, preview });
        }

        const { files: fileCount, failed, bytes, done, skipped = 0 } = run.attachments;
        const attachments = {
          ...run.attachments,
          done: done + 1,
          files: fileCount + step.files,
          failed: failed + step.failed,
          skipped: skipped + step.skipped,
          bytes: bytes + step.bytes,
        };
        run = { ...run, attachments, step: null };
        await writeRun(run, { [attKey(estimateId)]: rows });
      }
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

  return {
    isRunning: () => running !== null,

    async start({ tenant, host }) {
      if (running) return running;
      await clearRun(store);
      await files.clear();
      const entities = Object.fromEntries(ENTITIES.map((entity) => [entity.key, { pages: 0, count: 0, total: null, done: false }]));
      await writeRun({ provider: "servicetitan", status: "listing", startedAt: now(), company: tenant, tenant, host, entities, current: null });
      return launch();
    },

    async resume() {
      if (running) return running;
      const run = await readRun();
      if (!run || !ACTIVE.has(run.status)) return run;
      return launch();
    },

    // Pick up after an error at the page or estimate that failed.
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

    // The zip as parts for `new Blob(parts)`: one CSV per search with every
    // field, attachments.csv, and the files under attachments/.
    async archive() {
      const run = await readRun();
      const entries = [];
      for (const entity of ENTITIES) {
        const rows = (await records(entity.key, run)).map((record) => flatten(record));
        entries.push({ name: `${entity.key}.csv`, data: toCsv(columnsOf(rows), rows) });
      }

      const estimateIds = (await records("estimates", run)).map((record) => String(record.Id ?? "")).filter(Boolean);
      const saved = estimateIds.length ? await store.get(estimateIds.map(attKey)) : {};
      const attachments = estimateIds.flatMap((id) => saved[attKey(id)] ?? []);
      const csvRows = attachments.map(({ info, blob_key: _key, crc: _crc, ...row }) => ({ ...row, ...prefixed(info) }));
      entries.push({ name: "attachments.csv", data: toCsv([...ATTACHMENT_COLUMNS, ...columnsOf(csvRows).filter((c) => !ATTACHMENT_COLUMNS.includes(c))], csvRows) });

      for (const row of attachments) {
        if (row.status !== "saved") continue;
        const blob = await files.get(row.blob_key);
        if (blob) entries.push({ name: row.zip_path, blob, crc: row.crc, size: blob.size });
      }

      const stamp = new Date(run.finishedAt ?? now());
      return { parts: zipParts(entries, stamp), fileName: archiveName(run.tenant, stamp) };
    },
  };
}

function prefixed(info = {}) {
  return Object.fromEntries(Object.entries(info).map(([key, value]) => [`info.${key}`, value]));
}

function lastSegment(ref) {
  return String(ref ?? "").split("/").filter(Boolean).pop() ?? "";
}

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
// 3 document, 8 supplier product image). Checked live 2026-11-14.
export function categoryOf(kind, meta) {
  if (kind === "measurement") return "measurement";
  if (isCatalogImage(kind, meta)) return "catalog image";
  const what = { 1: "photo", 2: "video", 3: "document" }[meta.type] ?? "file";
  if (meta.ownerType === 1) return `job ${what}`;
  if (meta.ownerType === 5) return `sales ${what}`;
  return what;
}

// Pricebook and supplier catalog images all live under Images/ (job uploads
// live under Attaches/), including product photos copied onto a job.
function isCatalogImage(kind, meta) {
  return kind === "document" && (String(meta.fileRef).startsWith("Images/") || meta.ownerType === 8 || meta.type === 8);
}

function baseRow(kind, meta, { jobId, jobNumber, estimateId }) {
  return {
    kind,
    category: categoryOf(kind, meta),
    job_id: jobId,
    job_number: jobNumber,
    estimate_id: estimateId,
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

