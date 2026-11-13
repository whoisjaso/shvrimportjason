// Service worker: opens the app page from the toolbar icon, runs the export
// so it keeps going while the tab is in the background, and saves the zip.

import { createClient } from "./lib/hcp.js";
import { createExporter } from "./lib/exporter.js";

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

const exporter = createExporter({
  store,
  makeClient: (apiKey, { onWait }) => createClient({ apiKey, sleep, onWait }),
  onFinished: () => saveArchive(),
});

async function saveArchive() {
  const { bytes, fileName } = await exporter.archive();
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

chrome.runtime.onStartup.addListener(() => exporter.resume());

const actions = {
  start: () => exporter.start(),
  resume: () => exporter.resume(),
  retry: () => exporter.retry(),
  cancel: () => exporter.cancel(),
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
  const work = Promise.resolve(action()).catch((error) => console.error(error));
  if (message.type === "download" || message.type === "showFile") {
    work.finally(() => sendResponse({ ok: true }));
    return true;
  }
  // An export keeps running here; the page follows its progress in storage.
  sendResponse({ ok: true });
  return false;
});
