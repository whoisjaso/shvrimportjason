// The Jobber export run, in two phases. Everything is saved as it arrives,
// so a stopped worker resumes where it left off:
//
//   listing      page through jobs, clients, quotes, invoices and requests;
//                with attachments, each record's file list comes along
//   attachments  download every listed file from its presigned S3 link,
//                one saved page of records at a time, many files at once
//
// Storage (chrome.storage.local):
//   run                  status and counters; run.provider is "jobber"
//   jb:<entity>:<page>   records from one page (files listed under .files)
//   jbatt:<entity>:<page> attachment rows of one finished page
// Files (IndexedDB, see blobs.js): "jb:<entity>:<page>:<n>" -> Blob

import { AuthError, RequestError } from "./hcp.js";
import { ACTIVE, clearRun, archiveName } from "./exporter.js";
import { columnsOf, flatten } from "./flatten.js";
import { ENTITIES } from "./jobber.js";
import { toCsv } from "./rows.js";
import { crc32, zipParts } from "./zip.js";
import { isImage, lastSegment, limiter, prefixed, safeName, uniquePath } from "./files.js";

const MAX_PAGES = 5000;
// Presigned S3 downloads, measured 2026-11-16: about 0.2s each one at a
// time; 16 at once already filled the connection (about 37 files/s).
export const DOWNLOAD_CONCURRENCY = 16;
const PROGRESS_MS = 500;
const pageKey = (entity, page) => `jb:${entity}:${page}`;
const attKey = (entity, page) => `jbatt:${entity}:${page}`;

export const ATTACHMENT_COLUMNS = ["record_type", "record_id", "record_number", "file_name", "zip_path", "content_type", "size_bytes", "status", "error", "file_id"];

// makeClient({ onWait }) -> client from jobber.js
// files: { put(key, bytes, type), get(key) -> Blob, clear() }
export function createJobberExporter({ store, files, makeClient, now = () => Date.now(), onFinished = async () => {} }) {
  let running = null;
  let cancelRequested = false;

  async function readRun() {
    return (await store.get("run")).run ?? null;
  }

  async function writeRun(run, extra = {}) {
    await store.set({ run, ...extra });
    return run;
  }

  async function pagesOf(entityKey, run) {
    const keys = Array.from({ length: run.entities[entityKey].pages }, (_, i) => pageKey(entityKey, i + 1));
    const saved = keys.length ? await store.get(keys) : {};
    return keys.map((key) => saved[key] ?? []);
  }

  // Attachment work comes in pages that have at least one file.
  function unitsOf(run) {
    return ENTITIES.flatMap((entity) => (run.attachmentPages?.[entity.key] ?? []).map((page) => ({ entity, page, key: `${entity.key}:${page}` })));
  }

  async function work() {
    let run = await readRun();
    const client = makeClient({
      onWait: ({ reason, seconds }) => {
        run = { ...run, notice: { reason, until: now() + seconds * 1000 } };
        store.set({ run });
      },
    });
    const canceled = () => writeRun({ ...run, status: "canceled", notice: null });

    try {
      if (!run.sessionChecked) {
        const account = await client.account();
        run = await writeRun({ ...run, sessionChecked: true, company: run.company || account?.name || "" });
      }

      if (run.status === "listing") {
        for (const entity of ENTITIES) {
          const progress = run.entities[entity.key];
          while (!progress.done && progress.pages < MAX_PAGES) {
            if (cancelRequested) return await canceled();
            run = await writeRun({ ...run, current: entity.key, notice: null });
            const { records, total, endCursor, hasNextPage } = await client.listPage(entity, progress.cursor, run.includeAttachments);
            const page = progress.pages + 1;
            Object.assign(progress, { pages: records.length ? page : progress.pages, count: progress.count + records.length, total, cursor: endCursor, done: !hasNextPage || !records.length });
            const withFiles = records.some((record) => record.files?.length);
            const attachmentPages = withFiles ? { ...run.attachmentPages, [entity.key]: [...(run.attachmentPages?.[entity.key] ?? []), page] } : run.attachmentPages;
            run = { ...run, entities: { ...run.entities, [entity.key]: { ...progress } }, attachmentPages };
            await writeRun(run, records.length ? { [pageKey(entity.key, page)]: records } : {});
          }
        }
        if (run.includeAttachments) {
          const units = unitsOf(run);
          // Invoices repeat their jobs' files, so count each file once.
          const ids = new Set();
          for (const { entity, page } of units) {
            for (const record of (await store.get(pageKey(entity.key, page)))[pageKey(entity.key, page)] ?? []) {
              for (const file of record.files ?? []) ids.add(String(file.id));
            }
          }
          // Links only: the listing already holds every link; nothing to download.
          run = run.linksOnly
            ? await writeRun({ ...run, current: null, links: { files: ids.size } })
            : await writeRun({ ...run, status: "attachments", current: null, attachments: { total: units.length, done: 0, listed: ids.size, files: 0, failed: 0, bytes: 0 } });
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

    // One page of records at a time; its files download DOWNLOAD_CONCURRENCY
    // at once. A page's rows are saved only once all its files finished.
    // A file listed under several records (an invoice lists its job's files)
    // downloads once, under the first record; later ones get a "duplicate"
    // row pointing at the same zip path.
    async function fetchAttachments() {
      const units = unitsOf(run);
      const saved = units.length ? await store.get(units.map((unit) => attKey(unit.entity.key, unit.page))) : {};
      const usedPaths = new Set();
      const firstPath = new Map(); // file id -> zip path of its first row
      const totals = { ...run.attachments, done: 0, files: 0, failed: 0, bytes: 0 };
      for (const rows of Object.values(saved)) {
        totals.done += 1;
        for (const row of rows) {
          if (row.zip_path) usedPaths.add(row.zip_path);
          if (row.status !== "duplicate") firstPath.set(row.file_id, row.zip_path);
          if (row.status === "saved") {
            totals.files += 1;
            totals.bytes += Number(row.size_bytes) || 0;
          } else if (row.status === "failed") totals.failed += 1;
        }
      }
      const download = limiter(DOWNLOAD_CONCURRENCY);
      let preview = run.preview;
      let lastWrite = 0;
      const progress = async (force, extra = {}) => {
        if (!force && now() - lastWrite < PROGRESS_MS) return;
        lastWrite = now();
        run = { ...run, attachments: { ...totals }, preview };
        await writeRun(run, extra);
      };

      for (const unit of units) {
        const key = attKey(unit.entity.key, unit.page);
        if (saved[key]) continue;
        if (cancelRequested) return await canceled();
        const pageRecords = (await store.get(pageKey(unit.entity.key, unit.page)))[pageKey(unit.entity.key, unit.page)] ?? [];
        const rows = [];
        for (const record of pageRecords) {
          const number = String(record[unit.entity.number] ?? record.id ?? "");
          const folder = safeName(`${unit.entity.single} ${number}`);
          for (const file of record.files ?? []) {
            const fileId = String(file.id ?? "");
            const fileName = safeName(file.fileName || lastSegment(new URL(file.downloadUrl, "https://x/").pathname) || `file ${rows.length + 1}`);
            const row = {
              record_type: unit.entity.single,
              record_id: String(record.id ?? ""),
              record_number: number,
              file_name: fileName,
              zip_path: "",
              content_type: "",
              size_bytes: "",
              status: "",
              error: "",
              file_id: fileId,
              info: flatten(Object.fromEntries(Object.entries(file).filter(([name]) => name !== "downloadUrl"))),
            };
            if (fileId && firstPath.has(fileId)) {
              Object.assign(row, { zip_path: firstPath.get(fileId), status: "duplicate" });
            } else {
              Object.assign(row, { zip_path: uniquePath(`${folder}/${fileName}`, usedPaths), blob_key: `jb:${unit.key}:${rows.length}`, url: file.downloadUrl });
              if (fileId) firstPath.set(fileId, row.zip_path);
            }
            rows.push(row);
          }
        }
        run = { ...run, current: `${unit.entity.label} page ${unit.page}` };
        await progress(true);

        let stop = null;
        await Promise.all(
          rows.filter((row) => row.url).map((row) =>
            download(async () => {
              if (stop || cancelRequested) return;
              try {
                const file = await client.download(row.url);
                await files.put(row.blob_key, file.bytes, file.type);
                Object.assign(row, { content_type: file.type, size_bytes: String(file.bytes.length), status: "saved", crc: crc32(file.bytes) });
                totals.files += 1;
                totals.bytes += file.bytes.length;
                if (isImage(file.type, row.file_name)) preview = { key: row.blob_key, name: row.file_name, jobNumber: row.record_number };
              } catch (error) {
                // A refused or expired link is one failed file; anything else
                // (storage full, say) stops the run.
                if (!(error instanceof RequestError)) {
                  stop ??= error;
                  return;
                }
                Object.assign(row, { status: "failed", error: error.message });
                totals.failed += 1;
              }
              await progress(false);
            }),
          ),
        );
        if (stop) throw stop;
        if (cancelRequested) return await canceled();
        totals.done += 1;
        await progress(true, { [key]: rows.map(({ url: _url, ...row }) => row) });
      }
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

  return {
    isRunning: () => running !== null,

    // linksOnly: list the files but don't download them; the data zip gets
    // attachment_links.csv instead (Jobber's links work without a sign-in).
    async start({ includeAttachments = true, linksOnly = false } = {}) {
      if (running) return running;
      await clearRun(store);
      await files.clear();
      const entities = Object.fromEntries(ENTITIES.map((entity) => [entity.key, { pages: 0, count: 0, total: null, cursor: null, done: false }]));
      await writeRun({ provider: "jobber", status: "listing", startedAt: now(), company: "", includeAttachments: includeAttachments || linksOnly, linksOnly, entities, attachmentPages: {}, current: null });
      return launch();
    },

    async resume() {
      if (running) return running;
      const run = await readRun();
      if (!run || !ACTIVE.has(run.status)) return run;
      return launch();
    },

    async retry() {
      if (running) return running;
      const run = await readRun();
      if (!run) return null;
      await writeRun({ ...run, status: run.attachments ? "attachments" : "listing", error: null, notice: null, sessionChecked: false });
      return launch();
    },

    cancel() {
      cancelRequested = true;
    },

    // The data zip: one CSV per search, every exported field, and with
    // links only, attachment_links.csv.
    async archive() {
      const run = await readRun();
      const entries = [];
      for (const entity of ENTITIES) {
        const rows = (await pagesOf(entity.key, run)).flat().map(({ files: _files, ...record }) => flatten(record));
        entries.push({ name: `${entity.key}.csv`, data: toCsv(columnsOf(rows), rows) });
      }
      if (run.linksOnly) {
        const rows = [];
        for (const entity of ENTITIES) {
          for (const record of (await pagesOf(entity.key, run)).flat()) {
            for (const file of record.files ?? []) rows.push(linkRow(entity, record, file));
          }
        }
        entries.push({ name: "attachment_links.csv", data: toCsv(LINK_COLUMNS, rows) });
      }
      const stamp = new Date(run.finishedAt ?? now());
      return { parts: zipParts(entries, stamp), fileName: archiveName(run.company, stamp) };
    },

    // The attachments zip: attachments.csv and a folder per record. null
    // when the run skipped attachments.
    async attachmentsArchive() {
      const run = await readRun();
      if (!run.attachments) return null;
      const units = unitsOf(run);
      const saved = units.length ? await store.get(units.map((unit) => attKey(unit.entity.key, unit.page))) : {};
      const attachments = units.flatMap((unit) => saved[attKey(unit.entity.key, unit.page)] ?? []);
      const csvRows = attachments.map(({ info, blob_key: _key, crc: _crc, ...row }) => ({ ...row, ...prefixed(info) }));
      const entries = [{ name: "attachments.csv", data: toCsv([...ATTACHMENT_COLUMNS, ...columnsOf(csvRows).filter((c) => !ATTACHMENT_COLUMNS.includes(c))], csvRows) }];
      for (const row of attachments) {
        if (row.status !== "saved") continue;
        const blob = await files.get(row.blob_key);
        if (blob) entries.push({ name: row.zip_path, blob, crc: row.crc, size: blob.size });
      }
      const stamp = new Date(run.finishedAt ?? now());
      return { parts: zipParts(entries, stamp), fileName: archiveName(run.company, stamp, "SHVR Attachments") };
    },
  };
}

export const LINK_COLUMNS = ["record_type", "record_id", "record_number", "file_id", "file_name", "content_type", "size_bytes", "created_at", "description", "url", "expires_at"];

// One file's link. A file listed under several records (an invoice repeats
// its job's files) gets a row for each; file_id is the same.
function linkRow(entity, record, file) {
  return {
    record_type: entity.single,
    record_id: String(record.id ?? ""),
    record_number: String(record[entity.number] ?? record.id ?? ""),
    file_id: String(file.id ?? ""),
    file_name: file.fileName ?? "",
    content_type: file.contentType ?? "",
    size_bytes: file.fileSize ?? "",
    created_at: file.createdAt ?? "",
    description: file.description ?? "",
    url: file.downloadUrl ?? "",
    expires_at: linkExpiry(file.downloadUrl),
  };
}

// When a presigned S3 link stops working: X-Amz-Date plus X-Amz-Expires
// seconds (3 days for Jobber), as ISO 8601; "" when the link doesn't say.
export function linkExpiry(url) {
  try {
    const params = new URL(url).searchParams;
    const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(params.get("X-Amz-Date") ?? "");
    const seconds = Number(params.get("X-Amz-Expires"));
    if (!date || !Number.isFinite(seconds)) return "";
    const [, y, mo, d, h, mi, s] = date.map(Number);
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s) + seconds * 1000).toISOString();
  } catch {
    return "";
  }
}
