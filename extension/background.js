// Service worker: opens the app page from the toolbar icon, runs the export
// so it keeps going while the tab is in the background, and saves the zip.

import { createClient } from "./lib/hcp.js";
import { createExporter } from "./lib/exporter.js";
import { createServiceTitanClient } from "./lib/servicetitan.js";
import { createServiceTitanExporter } from "./lib/st-exporter.js";
import { fileStore } from "./lib/blobs.js";

const store = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

// Chrome stops an idle worker after 30 seconds without extension events or
// API calls. Long waits (a Retry-After, a backoff) touch the API every 10s.
async function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, end - Date.now())));
    await chrome.runtime.getPlatformInfo();
  }
}

const exporters = {
  hcp: createExporter({
    store,
    makeClient: (apiKey, { onWait }) => createClient({ apiKey, sleep, onWait }),
    onFinished: () => saveArchive(),
  }),
  // Attachments can run to gigabytes, so the open app page builds the
  // ServiceTitan zip from Blobs and downloads it (see app.js); a worker can't
  // make a Blob URL for chrome.downloads.
  servicetitan: createServiceTitanExporter({
    store,
    files: fileStore,
    makeClient: (host, { onWait }) => createServiceTitanClient({ host, sleep, onWait }),
  }),
};

// The exporter that owns the current run (or would own a new one).
async function currentExporter() {
  const { run } = await store.get("run");
  return exporters[run?.provider] ?? exporters.hcp;
}

const ST_HOST = /^[a-z0-9_-]+\.(?:[a-z0-9-]+\.)*servicetitan\.com$/i;

// Housecall Pro only: its zip is small enough for a data: URL.
async function saveArchive() {
  const { bytes, fileName } = await exporters.hcp.archive();
  const downloadId = await chrome.downloads.download({
    url: `data:application/zip;base64,${base64(bytes)}`,
    filename: fileName,
    conflictAction: "uniquify",
  });
  const { run } = await store.get("run");
  await store.set({ run: { ...run, downloadId, fileName } });
  return downloadId;
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});

chrome.runtime.onStartup.addListener(async () => (await currentExporter()).resume());

const actions = {
  start: (message) => {
    if (message.provider === "servicetitan") {
      if (!ST_HOST.test(message.host ?? "")) throw new Error("Not a ServiceTitan host.");
      return exporters.servicetitan.start({ tenant: String(message.tenant), host: message.host });
    }
    return exporters.hcp.start();
  },
  resume: async () => (await currentExporter()).resume(),
  retry: async () => (await currentExporter()).retry(),
  cancel: async () => (await currentExporter()).cancel(),
  download: () => saveArchive(),
  showFile: async () => {
    const { run } = await store.get("run");
    if (run?.downloadId) chrome.downloads.show(run.downloadId);
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const action = actions[message?.type];
  if (!action) return false;
  const work = Promise.resolve()
    .then(() => action(message))
    .catch((error) => console.error(error));
  if (message.type === "download" || message.type === "showFile") {
    work.finally(() => sendResponse({ ok: true }));
    return true;
  }
  // An export keeps running here; the page follows its progress in storage.
  sendResponse({ ok: true });
  return false;
});
