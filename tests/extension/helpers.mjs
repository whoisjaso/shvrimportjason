import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// chrome.storage.local's shape, in memory. get(null) returns everything.
export function memoryStore(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const list = keys === null ? Object.keys(data) : typeof keys === "string" ? [keys] : keys;
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

export function unzip(bytes, member) {
  const dir = mkdtempSync(join(tmpdir(), "export-test-"));
  const path = join(dir, "out.zip");
  writeFileSync(path, bytes);
  return execFileSync("unzip", ["-p", path, member], { encoding: "utf8" });
}
