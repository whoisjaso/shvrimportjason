// Minimal ZIP writer (stored, no compression). Entries can be text, bytes, or
// Blobs with a precomputed CRC and size, so large attachments never have to
// sit in one buffer: zipParts() returns pieces for `new Blob(parts)`.
// Switches to ZIP64 records when an entry, an offset or the entry count is too
// big for classic ZIP, so exports with many gigabytes of photos still open.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP64 extended-information extra field holding the given 64-bit values.
function zip64Extra(values) {
  const view = new DataView(new ArrayBuffer(4 + values.length * 8));
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, values.length * 8, true);
  values.forEach((value, i) => view.setBigUint64(4 + i * 8, BigInt(value), true));
  return new Uint8Array(view.buffer);
}

// entries: [{ name, data: string | Uint8Array }] or [{ name, blob, crc, size }].
// Returns [Uint8Array | Blob] parts in archive order.
export function zipParts(entries, date = new Date()) {
  const encoder = new TextEncoder();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    let body;
    let crc;
    let size;
    if (entry.blob) {
      ({ blob: body, crc, size } = entry);
    } else {
      body = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
      crc = crc32(body);
      size = body.length;
    }
    const bigSize = size >= MAX32;
    const bigOffset = offset >= MAX32;
    const version = bigSize || bigOffset ? 45 : 20;

    const localExtra = bigSize ? zip64Extra([size, size]) : new Uint8Array(0);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, version, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bigSize ? MAX32 : size, true);
    local.setUint32(22, bigSize ? MAX32 : size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, localExtra.length, true);
    locals.push(new Uint8Array(local.buffer), name, localExtra, body);

    const centralValues = [...(bigSize ? [size, size] : []), ...(bigOffset ? [offset] : [])];
    const centralExtra = centralValues.length ? zip64Extra(centralValues) : new Uint8Array(0);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, version, true); // version made by
    central.setUint16(6, version, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(12, time, true);
    central.setUint16(14, day, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, bigSize ? MAX32 : size, true);
    central.setUint32(24, bigSize ? MAX32 : size, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, centralExtra.length, true);
    central.setUint32(42, bigOffset ? MAX32 : offset, true);
    centrals.push(new Uint8Array(central.buffer), name, centralExtra);

    offset += 30 + name.length + localExtra.length + size;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const tail = [];
  const needs64 = entries.length >= MAX16 || offset >= MAX32 || centralSize >= MAX32;
  if (needs64) {
    const record = new DataView(new ArrayBuffer(56));
    record.setUint32(0, 0x06064b50, true);
    record.setBigUint64(4, 44n, true);
    record.setUint16(12, 45, true);
    record.setUint16(14, 45, true);
    record.setBigUint64(24, BigInt(entries.length), true);
    record.setBigUint64(32, BigInt(entries.length), true);
    record.setBigUint64(40, BigInt(centralSize), true);
    record.setBigUint64(48, BigInt(offset), true);
    const locator = new DataView(new ArrayBuffer(20));
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, BigInt(offset + centralSize), true);
    locator.setUint32(16, 1, true);
    tail.push(new Uint8Array(record.buffer), new Uint8Array(locator.buffer));
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, needs64 ? MAX16 : entries.length, true);
  end.setUint16(10, needs64 ? MAX16 : entries.length, true);
  end.setUint32(12, needs64 ? MAX32 : centralSize, true);
  end.setUint32(16, needs64 ? MAX32 : offset, true);
  tail.push(new Uint8Array(end.buffer));
  return [...locals, ...centrals, ...tail];
}

// Text and byte entries only; returns the archive as one Uint8Array.
export function makeZip(files, date = new Date()) {
  const parts = zipParts(files, date);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
