import { AuthError, createClient, findOrCreateApiKey } from "./lib/hcp.js";
import { ACTIVE } from "./lib/exporter.js";
import { fileStore } from "./lib/blobs.js";
import { ENTITIES, createServiceTitanClient, tenantsFromCookies } from "./lib/servicetitan.js";
import { createServiceTitanExporter } from "./lib/st-exporter.js";

const $ = (id) => document.getElementById(id);
const HCP_URL = "https://pro.housecallpro.com/";
const ST_URL = "https://go.servicetitan.com/";

const state = {
  provider: "hcp", // hcp | servicetitan
  apiKey: "",
  company: "",
  session: "pending", // pending | checking | ok | signed-out | unreachable
  hcpKey: "idle", // idle | working | ok | manual: the API key found or created after sign-in
  stTenants: [], // [{ tenant, host }] the browser is signed in to
  stTenant: "", // the chosen tenant
  stSession: "pending",
  stAttachments: true, // also export every job's files, as a second zip
  run: null,
};

const runProvider = (run) => run?.provider ?? "hcp";
const stChoice = () => state.stTenants.find((t) => t.tenant === state.stTenant) ?? state.stTenants[0] ?? null;

// --- Views -------------------------------------------------------------------

function showView(step, name) {
  for (const view of $(step).querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== name;
}

function setStep(step, stepState) {
  $(step).dataset.state = stepState;
}

function render() {
  const running = state.run && ACTIVE.has(state.run.status);
  // A running export pins the platform; otherwise show only this platform's run.
  if (running) state.provider = runProvider(state.run);
  const st = state.provider === "servicetitan";
  const run = runProvider(state.run) === state.provider ? state.run : null;

  for (const input of $("platform").querySelectorAll("input")) {
    input.checked = input.value === state.provider;
    input.disabled = Boolean(running);
  }
  const manualKey = !st && state.hcpKey === "manual";
  $("step-key").hidden = !manualKey;
  $("step-session").hidden = st;
  $("step-st-session").hidden = !st;
  $("export-num").textContent = st || !manualKey ? "2" : "3";
  $("start-label").textContent = "Export My Data";
  $("ready-text").textContent = st
    ? "This reads every job, estimate, customer, invoice, lead and payment. You'll get a zip file with a spreadsheet for each kind of record."
    : "This reads every job and estimate, then each job's materials and miscellaneous costs. A large account can take several minutes. You'll get one zip file of spreadsheets: jobs, materials, miscellaneous items, estimates, and estimate options.";
  $("st-attachments-option").hidden = !st;
  $("st-attachments").checked = state.stAttachments;

  let ready;
  if (st) {
    showView("step-st-session", state.stSession === "pending" ? "checking" : state.stSession);
    setStep("step-st-session", state.stSession === "ok" ? "done" : "current");
    const choice = stChoice();
    $("st-tenant-name").textContent = choice?.tenant ?? "";
    $("st-tenant-pick").hidden = state.stTenants.length < 2;
    $("st-tenant-select").disabled = Boolean(running);
    ready = state.stSession === "ok" && Boolean(choice);
  } else {
    // 1. Sign in; the API key is then found or created on its own.
    let sessionView = state.session === "pending" ? "checking" : state.session;
    if (state.session === "ok") {
      sessionView = state.hcpKey === "working" ? "connecting" : state.hcpKey === "ok" ? "ok" : "signed-in";
    }
    showView("step-session", sessionView);
    $("hcp-company").textContent = state.company;
    setStep("step-session", state.session === "ok" && state.hcpKey !== "working" ? "done" : "current");

    // 2. Only when that couldn't happen: paste a key by hand.
    if (manualKey) {
      const saved = Boolean(state.apiKey && state.company);
      showView("step-key", saved ? "saved" : "form");
      $("company-name").textContent = state.company;
      setStep("step-key", saved ? "done" : "current");
    }
    $("key-change").disabled = Boolean(running);
    ready = state.session === "ok" && Boolean(state.apiKey && state.company) && (state.hcpKey === "ok" || manualKey);
  }

  // Export
  let view = "pending";
  if (running) view = "running";
  else if (run?.status === "done") view = "done";
  else if (run?.status === "error") view = "error";
  else if (ready) view = run?.status === "canceled" ? "canceled" : "ready";
  showView("step-export", view);
  setStep("step-export", view === "done" ? "done" : view === "pending" ? "waiting" : "current");
  $("export-spinner").hidden = view !== "running";

  if (view === "running") renderRunning(run);
  if (view === "done") renderDone(run);
  if (view === "error") renderError(run, ready);
  renderParts(state.provider, run, view);
}

// --- Parts of the export (sidebar) ------------------------------------------
// Each part: { key, label, state: pending|active|done|stopped, count, part
// (0..1, or null when the total isn't known), detail, live }.

function stParts(run) {
  const listing = run?.status === "listing";
  const parts = ENTITIES.map((entity) => {
    const progress = run?.entities?.[entity.key];
    const done = Boolean(progress?.done);
    const active = listing && !done && (run.current === entity.key || !run.current);
    let count = "";
    if (done) count = fmt(progress.count);
    else if (active && progress?.count) count = progress.total ? `${fmt(progress.count)} of ${fmt(progress.total)}` : fmt(progress.count);
    const part = active && progress?.total ? Math.min(1, progress.count / progress.total) : null;
    return { key: entity.key, label: capitalize(entity.label), state: done ? "done" : active ? "active" : "pending", count, part };
  });
  // Only the first unfinished search is the active one.
  let seenActive = false;
  for (const part of parts) {
    if (part.state !== "active") continue;
    if (seenActive) part.state = "pending";
    seenActive = true;
  }

  // A run decides for itself; before one starts, the checkbox does.
  if (!(run ? run.includeAttachments || run.attachments : state.stAttachments)) return parts;
  const att = run?.attachments;
  const attachments = { key: "attachments", label: "Attachments", state: "pending", count: "", part: null, detail: "" };
  if (run?.status === "attachments" && att) {
    attachments.state = "active";
    attachments.count = `${fmt(att.files)} file${att.files === 1 ? "" : "s"}`;
    attachments.part = att.total ? att.done / att.total : 0;
    attachments.detail = `${fmt(att.done)} of ${fmt(att.total)} jobs · ${megabytes(att.bytes)}`;
    attachments.live = { current: run.current, preview: run.preview };
  } else if (run?.status === "done" && att) {
    attachments.state = "done";
    attachments.count = `${fmt(att.files)} file${att.files === 1 ? "" : "s"}`;
  }
  return [...parts, attachments];
}

function hcpParts(run) {
  const status = run?.status;
  const listedJobs = status === "costs" || status === "done" || (status !== "listing" && run?.total) || run?.listing === "estimates";
  const listedEstimates = status === "costs" || status === "done";
  const pages = run?.totalPages ? `page ${fmt(run.page)} of ${fmt(run.totalPages)}` : run?.page ? `page ${fmt(run.page)}` : "";
  const pagePart = run?.totalPages ? run.page / run.totalPages : null;
  const jobsActive = status === "listing" && !listedJobs;
  const estimatesActive = status === "listing" && run?.listing === "estimates";
  return [
    {
      key: "jobs",
      label: "Jobs",
      state: listedJobs ? "done" : jobsActive ? "active" : "pending",
      count: listedJobs && run?.total ? fmt(run.total) : jobsActive ? pages : "",
      part: jobsActive ? pagePart : null,
    },
    {
      key: "estimates",
      label: "Estimates",
      state: listedEstimates ? "done" : estimatesActive ? "active" : "pending",
      count: listedEstimates && run?.estimates !== undefined ? fmt(run.estimates) : estimatesActive ? pages : "",
      part: estimatesActive ? pagePart : null,
    },
    {
      key: "costs",
      label: "Job Materials and Costs",
      state: status === "done" ? "done" : status === "costs" ? "active" : "pending",
      count: status === "done" ? `${fmt(run.done)} jobs` : status === "costs" ? `${fmt(run.done)} of ${fmt(run.total)}` : "",
      part: status === "costs" && run.total ? run.done / run.total : null,
      detail: status === "costs" ? estimate(run) : "",
    },
  ];
}

// 0..1 across the whole export.
function overallOf(provider, run, parts) {
  if (run?.status === "done") return 1;
  if (provider === "servicetitan") {
    const searches = parts.filter((part) => part.key !== "attachments");
    const attachments = parts.find((part) => part.key === "attachments");
    const share = attachments ? 0.5 : 1;
    if (attachments?.state === "active") return share + (attachments.part ?? 0) * share;
    const finished = searches.filter((part) => part.state === "done").length;
    const current = searches.find((part) => part.state === "active");
    return ((finished + (current?.part ?? 0)) / searches.length) * share;
  }
  const [jobs, estimates, costs] = parts;
  if (costs.state === "active") return 0.1 + (costs.part ?? 0) * 0.9;
  if (estimates.state === "active") return 0.05 + (estimates.part ?? 0) * 0.05;
  return (jobs.part ?? 0) * 0.05;
}

function partsOf(provider, run) {
  return provider === "servicetitan" ? stParts(run) : hcpParts(run);
}

function renderRunning(run) {
  const provider = runProvider(run);
  const parts = partsOf(provider, run);
  const overall = overallOf(provider, run, parts);
  const pct = Math.floor(overall * 100);
  $("run-bar").setAttribute("aria-valuenow", String(pct));
  $("run-bar").querySelector(".fill").style.transform = `scaleX(${overall})`;
  $("run-pct").textContent = `${pct}%`;
  renderNotice(run);
}

function renderParts(provider, run, view) {
  // Rows for the selected platform; a run's progress only when it's that platform's.
  const parts = partsOf(provider, run);
  if (view === "error" || view === "canceled") {
    const stopped = parts.find((part) => part.state === "active") ?? parts.find((part) => part.state === "pending");
    if (stopped) stopped.state = "stopped";
  }
  $("parts").hidden = false;
  $("parts-title").textContent =
    view === "running" ? "Export Progress" : view === "done" ? "Export Complete" : view === "error" || view === "canceled" ? "Export Stopped" : "What Gets Exported";

  const list = $("parts-list");
  const keys = parts.map((part) => part.key).join(",");
  if (list.dataset.keys !== keys) {
    list.dataset.keys = keys;
    previewKey = null; // the new attachments row has an empty thumbnail
    list.replaceChildren(
      ...parts.map((part) => {
        const row = $("part-row").content.firstElementChild.cloneNode(true);
        row.dataset.key = part.key;
        return row;
      }),
    );
  }
  for (const part of parts) {
    const row = list.querySelector(`[data-key="${part.key}"]`);
    row.dataset.state = part.state;
    row.querySelector(".part-label").textContent = part.label;
    row.querySelector(".part-count").textContent = part.count;
    const bar = row.querySelector(".bar");
    bar.setAttribute("aria-label", `${part.label} progress`);
    bar.dataset.indeterminate = String(part.part === null);
    if (part.part !== null) {
      bar.setAttribute("aria-valuenow", String(Math.round(part.part * 100)));
      bar.querySelector(".fill").style.transform = `scaleX(${part.part})`;
    } else {
      bar.removeAttribute("aria-valuenow");
    }
    row.querySelector(".part-detail").textContent = part.detail ?? "";
    renderLive(row, part.state === "active" ? part.live : null);
  }
}

function renderLive(row, live) {
  const box = row.querySelector(".part-live");
  box.hidden = !live;
  if (!live) return;
  const where = live.current ? capitalize(live.current) : "";
  row.querySelector(".part-file").textContent = where ? `${where}: downloading…` : "Starting the next job…";
  renderPreview(row, live.preview);
}

// One thumbnail, swapped for each newly downloaded photo.
let previewKey = null;
let previewUrl = null;
async function renderPreview(row, preview) {
  if (!preview?.key || preview.key === previewKey) return;
  previewKey = preview.key;
  const blob = await fileStore.get(preview.key).catch(() => null);
  if (!blob || previewKey !== preview.key) return;
  const url = URL.createObjectURL(blob);
  const img = row.querySelector(".part-thumb img");
  img.onload = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    img.hidden = false;
    row.querySelector(".part-thumb-empty").hidden = true;
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
  row.querySelector(".part-thumb-name").textContent = preview.name;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderNotice(run) {
  const service = runProvider(run) === "servicetitan" ? "ServiceTitan" : "Housecall Pro";
  const notice = run.notice;
  const seconds = notice ? Math.ceil((notice.until - Date.now()) / 1000) : 0;
  $("run-notice").hidden = seconds <= 0;
  if (seconds > 0) {
    $("run-notice").textContent =
      notice.reason === "rate_limited"
        ? `${service} asked us to slow down. Continuing in ${seconds}s…`
        : `${service} didn't answer. Trying again in ${seconds}s…`;
  }
}

function estimate(run) {
  const pace = run.pace;
  if (!pace) return "";
  const fetched = run.done - pace.done;
  const elapsed = Date.now() - pace.at;
  if (fetched < 5 || elapsed <= 0) return "Working out how long this will take…";
  const minutes = Math.ceil(((run.total - run.done) * (elapsed / fetched)) / 60000);
  if (minutes <= 1) return "About a minute left";
  return `About ${minutes} minutes left`;
}

function renderDone(run) {
  const names = [run.fileName, run.attachmentsFileName].filter(Boolean);
  const two = Boolean(run.attachments);
  $("done-what").textContent = two ? "zip files are" : "zip file is";
  $("done-file").textContent = run.fileName ? names.join("\n") : building ? `Putting your zip file${two ? "s" : ""} together…` : "";
  if (runProvider(run) === "servicetitan") {
    const counts = ENTITIES.map((entity) => `${fmt(run.entities[entity.key].count)} ${entity.label}`).join(", ");
    const att = run.attachments;
    const files = att ? ` and ${fmt(att.files)} attachments (${megabytes(att.bytes)})` : "";
    const failed = att?.failed ? ` ${fmt(att.failed)} attachments or job listings couldn't be downloaded; attachments.csv lists them.` : "";
    const skipped = att?.skipped ? ` ${fmt(att.skipped)} pricebook and supplier product photos were left out.` : "";
    $("done-summary").textContent = `Exported ${counts}${files}.${skipped}${failed}`;
  } else {
    const estimates = run.estimates === undefined ? "" : ` and ${fmt(run.estimates)} estimates`;
    $("done-summary").textContent = `${fmt(run.done)} of ${fmt(run.total)} jobs${estimates} exported.`;
  }
  const failed = run.failed ?? [];
  $("failed").hidden = failed.length === 0;
  if (failed.length) {
    $("failed-text").textContent =
      failed.length === 1
        ? "1 job couldn't be read, so its costs aren't in the spreadsheets."
        : `${fmt(failed.length)} jobs couldn't be read, so their costs aren't in the spreadsheets.`;
    $("failed-list").replaceChildren(
      ...failed.map((job) => {
        const item = document.createElement("li");
        item.textContent = `Job ${job.invoice_number || job.job_id}: ${job.message}`;
        return item;
      }),
    );
  }
  $("show-file").hidden = !run.downloadId;
}

function renderError(run, ready) {
  const kind = run.error?.kind;
  const action = $("error-action");
  action.disabled = false;
  if (kind === "api_key") {
    $("error-text").textContent = "Housecall Pro stopped accepting your API key. It may have been deleted. Add a new one in step 1.";
    action.textContent = "Enter a New Key";
  } else if (kind === "session" && runProvider(run) === "servicetitan") {
    $("error-text").textContent =
      "You were signed out of ServiceTitan. Sign in again (step 1), then continue. Pages already read are kept.";
    action.textContent = "Continue";
    action.disabled = !ready;
  } else if (kind === "session") {
    $("error-text").textContent =
      "You were signed out of Housecall Pro. Sign in again (step 2), then continue. Jobs already read are kept.";
    action.textContent = "Continue";
    action.disabled = !ready;
  } else if (kind === "wrong_company") {
    $("error-text").textContent = `This browser is signed in to a different Housecall Pro company than ${run.company || "the API key's company"}. In Housecall Pro, switch to that company with the menu at the top left, then try again.`;
    action.textContent = "Try Again";
  } else {
    $("error-text").textContent = `Something went wrong: ${run.error?.message || "unknown error"} What was already read is kept.`;
    action.textContent = "Try Again";
  }
}

function megabytes(bytes) {
  const mb = (bytes || 0) / 1_048_576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

// --- ServiceTitan zip ----------------------------------------------------------
// Built here, not in the worker: the zip is assembled from stored Blobs and
// handed to chrome.downloads as a Blob URL, which a worker can't create.

const store = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};
const stArchiver = createServiceTitanExporter({ store, files: fileStore, makeClient: () => null });
let building = false;
const blobUrls = new Map(); // download id -> object URL, revoked when it finishes

// Two downloads: the spreadsheets, then (when the run fetched them) the
// attachments. The data zip is small; the attachments one can be gigabytes.
async function saveStZip() {
  if (building) return;
  building = true;
  render();
  try {
    const download = async ({ parts, fileName }) => {
      const url = URL.createObjectURL(new Blob(parts, { type: "application/zip" }));
      const id = await chrome.downloads.download({ url, filename: fileName, conflictAction: "uniquify" });
      blobUrls.set(id, url);
      return id;
    };
    const data = await stArchiver.archive();
    const downloadId = await download(data);
    const attachments = await stArchiver.attachmentsArchive();
    if (attachments) await download(attachments);
    const { run } = await store.get("run");
    await store.set({ run: { ...run, downloadId, fileName: data.fileName, attachmentsFileName: attachments?.fileName ?? "" } });
  } finally {
    building = false;
    render();
  }
}

function maybeSaveStZip() {
  const run = state.run;
  if (run?.provider === "servicetitan" && run.status === "done" && !run.downloadId) saveStZip();
}

chrome.downloads.onChanged.addListener(({ id, state: change }) => {
  if (!blobUrls.has(id) || !change || change.current === "in_progress") return;
  URL.revokeObjectURL(blobUrls.get(id));
  blobUrls.delete(id);
});

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

// --- Actions -----------------------------------------------------------------

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function startExport() {
  if (state.provider !== "servicetitan") return send("start");
  const choice = stChoice();
  if (choice) send("start", { provider: "servicetitan", tenant: choice.tenant, host: choice.host, includeAttachments: state.stAttachments });
}

function normalizeKey(raw) {
  return raw
    .trim()
    .replace(/^authorization\s*:\s*/i, "")
    .replace(/^(token|bearer)\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

async function saveKey(event) {
  event.preventDefault();
  const key = normalizeKey($("key-input").value);
  const error = $("key-error");
  error.hidden = true;
  if (!key || /\s/.test(key)) {
    error.textContent = "That doesn't look like an API key. Copy it again from Housecall Pro and paste it here.";
    error.hidden = false;
    return;
  }
  const button = $("key-save");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const company = await createClient({ apiKey: key, delayMs: 0 }).company();
    const name = company.name || company.business_name || "your company";
    await chrome.storage.local.set({ apiKey: key, company: name });
    $("key-input").value = "";
  } catch (err) {
    error.textContent =
      err instanceof AuthError
        ? "Housecall Pro didn't accept that key. Copy it again from API Key Management and paste the whole key."
        : "Couldn't reach Housecall Pro to check the key. Check your internet connection and try again.";
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Save Key";
  }
}

async function changeKey() {
  await chrome.storage.local.remove(["apiKey", "company"]);
  $("key-input").focus();
}

let checking = null;
async function checkSession() {
  if (checking) return checking;
  if (state.session !== "ok") {
    state.session = "pending";
    render();
  }
  checking = (async () => {
    try {
      await createClient({ delayMs: 0 }).checkSession();
      state.session = "ok";
      if (state.hcpKey === "idle") setupApiKey();
    } catch (err) {
      state.session = err instanceof AuthError ? "signed-out" : "unreachable";
    } finally {
      checking = null;
      render();
    }
  })();
  return checking;
}

// After sign-in: use the company's SHVR API key, or make a read-only one, so
// nobody has to paste a key. Falls back to the paste-a-key step when the
// signed-in user can't manage keys (only admins can) or the plan lacks the API.
async function setupApiKey() {
  state.hcpKey = "working";
  render();
  try {
    const { apiKey } = await findOrCreateApiKey(createClient({ delayMs: 0 }));
    const company = await createClient({ apiKey, delayMs: 0 }).company();
    await chrome.storage.local.set({ apiKey, company: company.name || company.business_name || "your company" });
    state.hcpKey = "ok";
  } catch (error) {
    console.warn("Automatic API key setup failed:", error);
    state.hcpKey = "manual";
  }
  render();
}

let stChecking = null;
async function checkStSession() {
  if (stChecking) return stChecking;
  if (state.stSession !== "ok") {
    state.stSession = "pending";
    render();
  }
  stChecking = (async () => {
    try {
      state.stTenants = tenantsFromCookies(await chrome.cookies.getAll({ domain: "servicetitan.com" }));
      const choice = stChoice();
      if (!choice) {
        state.stSession = "signed-out";
        return;
      }
      state.stTenant = choice.tenant;
      renderTenantOptions();
      await createServiceTitanClient({ host: choice.host, delayMs: 0 }).checkSession();
      state.stSession = "ok";
    } catch (err) {
      state.stSession = err instanceof AuthError ? "signed-out" : "unreachable";
    } finally {
      stChecking = null;
      render();
    }
  })();
  return stChecking;
}

function renderTenantOptions() {
  $("st-tenant-select").replaceChildren(
    ...state.stTenants.map(({ tenant }) => {
      const option = document.createElement("option");
      option.value = tenant;
      option.textContent = tenant;
      option.selected = tenant === state.stTenant;
      return option;
    }),
  );
}

// Recheck whichever sign-in the chosen platform needs.
function recheck() {
  if (state.provider === "servicetitan") {
    if (state.stSession !== "ok") checkStSession();
  } else if (state.session !== "ok") {
    checkSession();
  }
}

async function errorAction() {
  const kind = state.run?.error?.kind;
  if (kind === "api_key") {
    await changeKey();
    await chrome.storage.local.remove("run");
    return;
  }
  send("retry");
}

// --- Wiring ------------------------------------------------------------------

$("key-form").addEventListener("submit", saveKey);
$("key-change").addEventListener("click", changeKey);
$("open-hcp").addEventListener("click", () => chrome.tabs.create({ url: HCP_URL }));
$("session-retry").addEventListener("click", checkSession);
$("open-st").addEventListener("click", () => chrome.tabs.create({ url: ST_URL }));
$("st-session-retry").addEventListener("click", checkStSession);
$("st-tenant-select").addEventListener("change", async (event) => {
  state.stTenant = event.target.value;
  await chrome.storage.local.set({ stTenant: state.stTenant });
  state.stSession = "pending";
  checkStSession();
});
$("st-attachments").addEventListener("change", async (event) => {
  state.stAttachments = event.target.checked;
  await chrome.storage.local.set({ stAttachments: state.stAttachments });
  render();
});
for (const input of $("platform").querySelectorAll("input")) {
  input.addEventListener("change", async () => {
    state.provider = input.value;
    await chrome.storage.local.set({ provider: state.provider });
    render();
    recheck();
  });
}
$("start").addEventListener("click", startExport);
$("start-again").addEventListener("click", startExport);
$("start-over").addEventListener("click", startExport);
$("error-start-over").addEventListener("click", startExport);
$("cancel").addEventListener("click", () => send("cancel"));
$("retry-failed").addEventListener("click", () => send("retry"));
$("error-action").addEventListener("click", errorAction);
$("show-file").addEventListener("click", () => send("showFile"));
$("download-again").addEventListener("click", () => (state.run?.provider === "servicetitan" ? saveStZip() : send("download")));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("run" in changes) state.run = changes.run.newValue ?? null;
  if ("apiKey" in changes) state.apiKey = changes.apiKey.newValue ?? "";
  if ("company" in changes) state.company = changes.company.newValue ?? "";
  if ("provider" in changes && changes.provider.newValue) {
    state.provider = changes.provider.newValue === "servicetitan" ? "servicetitan" : "hcp";
    recheck();
  }
  render();
  maybeSaveStZip();
});

// Coming back from the Housecall Pro or ServiceTitan tab after signing in.
window.addEventListener("focus", recheck);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) recheck();
});

// Keep a running export going if Chrome stopped the background worker, and
// keep the time estimate and countdowns fresh.
setInterval(() => {
  if (state.run && ACTIVE.has(state.run.status)) send("resume");
}, 5000);
setInterval(() => {
  if (state.run && ACTIVE.has(state.run.status)) render();
}, 1000);

const stored = await chrome.storage.local.get(["apiKey", "company", "run", "provider", "stTenant", "stAttachments"]);
state.apiKey = stored.apiKey ?? "";
state.company = stored.apiKey ? (stored.company ?? "") : "";
state.run = stored.run ?? null;
state.provider = stored.provider === "servicetitan" ? "servicetitan" : "hcp";
state.stTenant = stored.stTenant ?? "";
state.stAttachments = stored.stAttachments !== false;
render();
if (state.provider === "hcp") checkSession();
if (state.provider === "servicetitan") checkStSession();
if (state.run && ACTIVE.has(state.run.status)) send("resume");
maybeSaveStZip();
