// Spreadsheet rows for the three CSVs. Money arrives in cents and leaves in
// dollars; every cost row carries its job's id and invoice number.

export const JOB_COLUMNS = [
  "job_id",
  "invoice_number",
  "description",
  "work_status",
  "customer_id",
  "customer_name",
  "customer_company",
  "customer_email",
  "customer_mobile",
  "street",
  "street_line_2",
  "city",
  "state",
  "zip",
  "scheduled_start",
  "scheduled_end",
  "on_my_way_at",
  "started_at",
  "completed_at",
  "created_at",
  "updated_at",
  "canceled_at",
  "deleted_at",
  "subtotal",
  "total_amount",
  "outstanding_balance",
  "assigned_employees",
  "assigned_employee_ids",
  "tags",
  "lead_source",
  "job_type",
  "business_unit",
  "original_estimate_id",
  "recurrence_rule",
];

export const MATERIAL_COLUMNS = [
  "job_id",
  "invoice_number",
  "material_uuid",
  "name",
  "part_number",
  "description",
  "quantity",
  "unit_of_measure",
  "unit_cost",
  "total_cost",
  "vendor",
  "vendor_uuid",
  "purchase_status",
  "purchase_status_uuid",
  "material_source",
  "material_source_uuid",
  "pricebook_material_uuid",
];

export const MISC_COLUMNS = ["job_id", "invoice_number", "item_uuid", "name", "description", "quantity", "unit_cost", "total_cost"];

export function jobRow(job) {
  const customer = isObject(job.customer) ? job.customer : {};
  const employees = (Array.isArray(job.assigned_employees) ? job.assigned_employees : []).filter(isObject);
  return {
    job_id: text(job.id),
    invoice_number: text(job.invoice_number),
    description: text(job.description),
    work_status: text(job.work_status),
    customer_id: text(customer.id),
    customer_name: fullName(customer),
    customer_company: text(customer.company),
    customer_email: text(customer.email),
    customer_mobile: text(customer.mobile_number),
    street: dig(job, "address", "street"),
    street_line_2: dig(job, "address", "street_line_2"),
    city: dig(job, "address", "city"),
    state: dig(job, "address", "state"),
    zip: dig(job, "address", "zip"),
    scheduled_start: dig(job, "schedule", "scheduled_start"),
    scheduled_end: dig(job, "schedule", "scheduled_end"),
    on_my_way_at: dig(job, "work_timestamps", "on_my_way_at"),
    started_at: dig(job, "work_timestamps", "started_at"),
    completed_at: dig(job, "work_timestamps", "completed_at"),
    created_at: text(job.created_at),
    updated_at: text(job.updated_at),
    canceled_at: text(job.canceled_at),
    deleted_at: text(job.deleted_at),
    subtotal: dollars(job.subtotal),
    total_amount: dollars(job.total_amount),
    outstanding_balance: dollars(job.outstanding_balance),
    assigned_employees: join(employees.map(fullName)),
    assigned_employee_ids: join(employees.map((employee) => employee.id)),
    tags: join(Array.isArray(job.tags) ? job.tags : []),
    lead_source: text(job.lead_source),
    job_type: dig(job, "job_fields", "job_type", "name"),
    business_unit: dig(job, "job_fields", "business_unit", "name"),
    original_estimate_id: text(job.original_estimate_id),
    recurrence_rule: text(job.recurrence_rule),
  };
}

export function materialRow(jobId, invoiceNumber, material) {
  const [vendor, vendorUuid] = expanded(material.material_vendor);
  const [status, statusUuid] = expanded(material.material_purchase_status);
  const [source, sourceUuid] = expanded(material.material_source);
  const quantity = number(material.quantity);
  return {
    job_id: jobId,
    invoice_number: invoiceNumber,
    material_uuid: text(material.uuid),
    name: text(material.name),
    part_number: text(material.part_number),
    description: text(material.description),
    quantity: text(material.quantity),
    unit_of_measure: text(material.unit_of_measure),
    unit_cost: dollars(material.unit_cost),
    total_cost: totalDollars(quantity, material.unit_cost),
    vendor,
    vendor_uuid: vendorUuid,
    purchase_status: status,
    purchase_status_uuid: statusUuid,
    material_source: source,
    material_source_uuid: sourceUuid,
    pricebook_material_uuid: text(material.pricebook_material_uuid),
  };
}

export function miscRow(jobId, invoiceNumber, item) {
  const quantity = Number.isInteger(item.qty_in_hundredths) ? item.qty_in_hundredths / 100 : number(item.quantity);
  return {
    job_id: jobId,
    invoice_number: invoiceNumber,
    item_uuid: text(item.uuid),
    name: text(item.name),
    description: text(item.description),
    quantity: quantity === null ? "" : String(quantity),
    unit_cost: dollars(item.unit_cost),
    total_cost: totalDollars(quantity, item.unit_cost),
  };
}

// CSV text with a byte-order mark so Excel reads accents and dashes right.
export function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function csvCell(value) {
  const cell = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function dollars(cents) {
  const value = number(cents);
  return value === null ? "" : (value / 100).toFixed(2);
}

function totalDollars(quantity, unitCostCents) {
  const unit = number(unitCostCents);
  if (quantity === null || unit === null) return "";
  return (Math.round(quantity * unit) / 100).toFixed(2);
}

// Name and uuid of an expanded relation: {data: {...}}, a bare object, or a string.
function expanded(value) {
  if (isObject(value)) {
    const record = isObject(value.data) ? value.data : value;
    return [text(record.name), text(record.uuid ?? record.id)];
  }
  if (typeof value === "string") return [value, ""];
  return ["", ""];
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fullName(person) {
  return [person.first_name, person.last_name].filter(Boolean).join(" ");
}

function join(values) {
  return values.filter((value) => value !== null && value !== undefined && value !== "").join("; ");
}

function dig(record, ...keys) {
  let value = record;
  for (const key of keys) {
    if (!isObject(value)) return "";
    value = value[key];
  }
  return text(value);
}

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
