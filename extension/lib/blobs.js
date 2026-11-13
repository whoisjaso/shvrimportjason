// Downloaded attachment files, kept in IndexedDB until the zip is built.
// The service worker writes them; the app page reads them back as Blobs to
// assemble the zip (a worker can't hand a Blob URL to chrome.downloads).

const DB_NAME = "export-files";
const STORE = "files";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const fileStore = {
  put: (key, bytes, type) => run("readwrite", (store) => store.put(new Blob([bytes], { type }), key)),
  get: (key) => run("readonly", (store) => store.get(key)),
  clear: () => run("readwrite", (store) => store.clear()),
};
