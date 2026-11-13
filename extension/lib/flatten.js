// Turn whole JSON records into CSV rows without dropping anything: nested
// objects become dotted columns ("Customer.Name"), lists of plain values are
// joined with "; ", and lists of objects are kept as JSON text.

export function flatten(record, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(record)) {
    const column = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) {
      out[column] = "";
    } else if (Array.isArray(value)) {
      out[column] = value.every((item) => item === null || typeof item !== "object")
        ? value.filter((item) => item !== null && item !== "").join("; ")
        : JSON.stringify(value);
    } else if (typeof value === "object") {
      if (Object.keys(value).length === 0) out[column] = "";
      else flatten(value, column, out);
    } else {
      out[column] = String(value);
    }
  }
  return out;
}

// Every column any row has, in first-seen order.
export function columnsOf(rows) {
  const seen = new Set();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}
