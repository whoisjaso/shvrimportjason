// The "Line items" text column on Jobber's jobs.csv and quotes.csv, which
// SHVR's CRM Migration import reads, and the check of each record's lines
// against its subtotal. The line item rows come from *_line_items.csv
// (see jobber-exporter.js); their values are text.

// THE setting for the Line items column. Change it here and nowhere else.
//   header     the column's name (SHVR's Jobs template calls it "Line items")
//   entities   which record files get the column
//   item       one line item; {field} is replaced by that column of the
//              record's *_line_items.csv row
//   separator  what goes between items (a line break: one item per line)
// Jobber's own One-Off Jobs report format couldn't be confirmed, so this is
// name, quantity and unit price, one item per line.
export const LINE_ITEMS_TEXT = {
  header: "Line items",
  entities: ["jobs", "quotes"],
  item: "{name} (qty {quantity}, unit price {unitPrice})",
  separator: "\n",
};

// The quote line item fields that say a line isn't part of what was sold.
// textOnly: a heading or note, not a product or service. optional without
// recommended: an optional line that isn't counted in the quote's subtotal.
// Checked against a real export's quote_line_items.csv (2026-11-25): there,
// recommended is blank on lines that aren't optional, and true or false on
// optional ones; with this rule 820 of 853 quotes add up to their subtotal.
export const QUOTE_LINE_FIELDS = { textOnly: "textOnly", optional: "optional", recommended: "recommended" };

// Is this line left out of the Line items column and the subtotal check?
// Only quotes leave lines out: text-only lines, and optional lines that
// aren't recommended. Lines with a zero quantity or a negative price are
// kept.
export function leftOut(entityKey, row, fields = QUOTE_LINE_FIELDS) {
  if (entityKey !== "quotes") return false;
  return row[fields.textOnly] === "true" || (row[fields.optional] === "true" && row[fields.recommended] !== "true");
}

const inOrder = (rows) => [...rows].sort((a, b) => Number(a.position) - Number(b.position));

// A record's lines as one cell of text, in position order.
export function lineItemsText(entityKey, rows, setting = LINE_ITEMS_TEXT) {
  return inOrder(rows)
    .filter((row) => !leftOut(entityKey, row))
    .map((row) => setting.item.replace(/\{(\w+)\}/g, (_, field) => row[field] ?? ""))
    .join(setting.separator);
}

export const CHECK_COLUMNS = ["record_type", "record_id", "record_number", "lines", "lines_left_out", "negative_lines", "line_total", "subtotal", "difference"];

const cents = (value) => (value === "" || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100));
const money = (value) => (value / 100).toFixed(2);

// One row when a record's kept lines don't add up to its subtotal, else
// null. totalPrice is used exactly as Jobber gave it. A record with no
// subtotal, or a line with no totalPrice, can't be checked.
export function subtotalCheck(entity, record, rows) {
  const subtotal = cents(record["amounts.subtotal"] ?? record.subtotal);
  if (subtotal === null) return null;
  const kept = rows.filter((row) => !leftOut(entity.key, row));
  const prices = kept.map((row) => cents(row.totalPrice));
  if (prices.includes(null)) return null;
  const total = prices.reduce((sum, price) => sum + price, 0);
  if (total === subtotal) return null;
  return {
    record_type: entity.single,
    record_id: record.id ?? "",
    record_number: record[entity.number] ?? "",
    lines: String(kept.length),
    lines_left_out: String(rows.length - kept.length),
    negative_lines: String(prices.filter((price) => price < 0).length),
    line_total: money(total),
    subtotal: money(subtotal),
    difference: money(total - subtotal),
  };
}
