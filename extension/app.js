import { AuthError, createClient } from "./lib/hcp.js";
import { ACTIVE } from "./lib/exporter.js";

const $ = (id) => document.getElementById(id);
const HCP_URL = "https://pro.housecallpro.com/";

const state = {
  apiKey: "",
  company: "",
  session: "pending", // pending | checking | ok | signed-out | unreachable
  run: null,
};

// --- Views -------------------------------------------------------------------

function showView(step, name) {
  for (const view of $(step).querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== name;
}

function setStep(step, stepState) {
  $(step).dataset.state = stepState;
}

function render() {
  const run = state.run;
  const running = run && ACTIVE.has(run.status);

  // 1. API key
  if (state.apiKey && state.company) {
    showView("step-key", "saved");
    $("company-name").textContent = state.company;
    setStep("step-key", "done");
  } else {
    showView("step-key", "form");
    setStep("step-key", "current");
  }
  $("key-change").disabled = Boolean(running);

  // 2. Session
  if (!state.company) {
    showView("step-session", "pending");
    setStep("step-session", "waiting");
  } else {
    showView("step-session", state.session === "pending" ? "checking" : state.session);
    setStep("step-session", state.session === "ok" ? "done" : "current");
  }

  // 3. Export
  const ready = Boolean(state.company) && state.session === "ok";
  let view = "pending";
  if (running) view = "running";
  else if (run?.status === "done") view = "done";
  else if (run?.status === "error") view = "error";
  else if (ready) view = run?.status === "canceled" ? "canceled" : "ready";
  showView("step-export", view);
  setStep("step-export", view === "done" ? "done" : view === "pending" ? "waiting" : "current");

  if (view === "running") renderProgress(run);
  if (view === "done") renderDone(run);
  if (view === "error") renderError(run, ready);
}

function renderProgress(run) {
  let percent = 0;
  let status = "Starting…";
  let eta = "";
  if (run.status === "listing") {
    if (run.totalPages) {
      status = `Getting your job list (page ${run.page} of ${run.totalPages})`;
      percent = (run.page / run.totalPages) * 100;
    } else {
      status = run.page ? `Getting your job list (page ${run.page})` : "Connecting to Housecall Pro…";
    }
  } else {
    status = `Reading job costs: ${fmt(run.done)} of ${fmt(run.total)} jobs`;
    percent = run.total ? (run.done / run.total) * 100 : 100;
    eta = estimate(run);
  }
  $("run-status").textContent = status;
  $("run-bar").setAttribute("aria-valuenow", String(Math.round(percent)));
  $("run-bar").querySelector(".fill").style.width = `${percent}%`;
  $("run-bar").dataset.phase = run.status;
  $("run-eta").textContent = eta;

  const notice = run.notice;
  const seconds = notice ? Math.ceil((notice.until - Date.now()) / 1000) : 0;
  $("run-notice").hidden = seconds <= 0;
  if (seconds > 0) {
    $("run-notice").textContent =
      notice.reason === "rate_limited"
        ? `Housecall Pro asked us to slow down. Continuing in ${seconds}s…`
        : `Housecall Pro didn't answer. Trying again in ${seconds}s…`;
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
  $("done-file").textContent = run.fileName || "";
  $("done-summary").textContent = `${fmt(run.done)} of ${fmt(run.total)} jobs exported.`;
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
    action.textContent = "Enter a new key";
  } else if (kind === "session") {
    $("error-text").textContent =
      "You were signed out of Housecall Pro. Sign in again (step 2), then continue. Jobs already read are kept.";
    action.textContent = "Continue";
    action.disabled = !ready;
  } else if (kind === "wrong_company") {
    $("error-text").textContent = `This browser is signed in to a different Housecall Pro company than ${run.company || "the API key's company"}. In Housecall Pro, switch to that company with the menu at the top left, then try again.`;
    action.textContent = "Try again";
  } else {
    $("error-text").textContent = `Something went wrong: ${run.error?.message || "unknown error"} Jobs already read are kept.`;
    action.textContent = "Try again";
  }
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

// --- Actions -----------------------------------------------------------------

function send(type) {
  return chrome.runtime.sendMessage({ type });
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
    button.textContent = "Save key";
  }
}

async function changeKey() {
  await chrome.storage.local.remove(["apiKey", "company"]);
  $("key-input").focus();
}

let checking = null;
async function checkSession() {
  if (!state.company || checking) return checking;
  if (state.session !== "ok") {
    state.session = "pending";
    render();
  }
  checking = (async () => {
    try {
      await createClient({ delayMs: 0 }).checkSession();
      state.session = "ok";
    } catch (err) {
      state.session = err instanceof AuthError ? "signed-out" : "unreachable";
    } finally {
      checking = null;
      render();
    }
  })();
  return checking;
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
$("start").addEventListener("click", () => send("start"));
$("start-again").addEventListener("click", () => send("start"));
$("start-over").addEventListener("click", () => send("start"));
$("error-start-over").addEventListener("click", () => send("start"));
$("cancel").addEventListener("click", () => send("cancel"));
$("retry-failed").addEventListener("click", () => send("retry"));
$("error-action").addEventListener("click", errorAction);
$("show-file").addEventListener("click", () => send("showFile"));
$("download-again").addEventListener("click", () => send("download"));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("run" in changes) state.run = changes.run.newValue ?? null;
  if ("apiKey" in changes) state.apiKey = changes.apiKey.newValue ?? "";
  if ("company" in changes) {
    state.company = changes.company.newValue ?? "";
    if (state.company) checkSession();
  }
  render();
});

// Coming back from the Housecall Pro tab after signing in.
window.addEventListener("focus", () => {
  if (state.session !== "ok") checkSession();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.session !== "ok") checkSession();
});

// Keep a running export going if Chrome stopped the background worker, and
// keep the time estimate and countdowns fresh.
setInterval(() => {
  if (state.run && ACTIVE.has(state.run.status)) send("resume");
}, 5000);
setInterval(() => {
  if (state.run && ACTIVE.has(state.run.status)) render();
}, 1000);

const stored = await chrome.storage.local.get(["apiKey", "company", "run"]);
state.apiKey = stored.apiKey ?? "";
state.company = stored.apiKey ? (stored.company ?? "") : "";
state.run = stored.run ?? null;
render();
if (state.company) checkSession();
if (state.run && ACTIVE.has(state.run.status)) send("resume");
