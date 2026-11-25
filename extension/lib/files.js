// Helpers shared by the exporters that download attachments.

// Runs at most `max` of the given async functions at once.
export function limiter(max) {
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

// A flattened record's fields as info.* CSV columns.
export function prefixed(info = {}) {
  return Object.fromEntries(Object.entries(info).map(([key, value]) => [`info.${key}`, value]));
}

export function lastSegment(ref) {
  return String(ref ?? "").split("/").filter(Boolean).pop() ?? "";
}

export const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i;
export const VIDEO_EXT = /\.(mp4|mov|m4v|avi|webm|3gp|mkv)$/i;

// Some servers label photos "unknown/unknown", so fall back to the name.
export function isImage(type, name) {
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

// `path`, or "name (2).ext" and so on when it's taken; claims the result.
export function uniquePath(path, used) {
  let candidate = path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 2; used.has(candidate); n += 1) candidate = `${stem} (${n})${ext}`;
  used.add(candidate);
  return candidate;
}
