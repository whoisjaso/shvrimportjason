// ServiceTitan's own web app endpoints, called with the browser's signed-in
// session (.AspNetCore.AUTH* cookies on the tenant's host). No API key.
//
//   POST https://<tenant>.eh.go.servicetitan.com/Search/<Entity>
//   {"filter": {"page": N}, "criteriaString": "{}"}
//
// The search result's exact shape isn't documented, so rows are taken from
// the first record list found in the body and kept whole.

import { AuthError, RequestError, createRequester } from "./hcp.js";

export const ENTITIES = [
  { key: "jobs", search: "Job", label: "jobs" },
  { key: "estimates", search: "Estimate", label: "estimates" },
  { key: "customers", search: "Customer", label: "customers" },
  { key: "invoices", search: "Invoice", label: "invoices" },
  { key: "leads", search: "Lead", label: "leads" },
  { key: "payments", search: "Payment", label: "payments" },
];

const LIST_KEYS = ["data", "Data", "items", "Items", "results", "Results", "rows", "Rows", "records", "Records", "list", "List"];
const TOTAL_KEYS = ["total", "Total", "totalCount", "TotalCount", "totalItems", "TotalItems", "count", "Count"];
const TENANT_HOST = /^\.?([a-z0-9_-]+)\.((?:[a-z0-9-]+\.)*servicetitan\.com)$/i;

export function hostFor(tenant) {
  return `${tenant}.eh.go.servicetitan.com`;
}

// Tenants this browser is signed in to, from its cookies:
// [{ tenant, host }]. Prefers the host an auth cookie is scoped to; falls
// back to the st_tenant cookie with the usual host.
export function tenantsFromCookies(cookies) {
  const found = new Map();
  for (const cookie of cookies) {
    if (!cookie.name.startsWith(".AspNetCore.AUTH")) continue;
    const match = TENANT_HOST.exec(cookie.domain);
    if (match && !["go", "www", "auth", "login"].includes(match[1].toLowerCase())) {
      found.set(match[1], { tenant: match[1], host: `${match[1]}.${match[2]}` });
    }
  }
  for (const cookie of cookies) {
    if (cookie.name === "st_tenant" && cookie.value && !found.has(cookie.value)) {
      found.set(cookie.value, { tenant: cookie.value, host: hostFor(cookie.value) });
    }
  }
  return [...found.values()];
}

export function createServiceTitanClient({ host, fetch, sleep, now, delayMs, onWait } = {}) {
  const request = createRequester({ fetch, sleep, now, delayMs, onWait, service: "ServiceTitan" });
  const signedOut = () => new AuthError("session", "You're not signed in to ServiceTitan in this browser.");

  async function search(entity, page) {
    const body = await request(
      `https://${host}/Search/${entity}`,
      {
        method: "POST",
        credentials: "include",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ filter: { page }, criteriaString: "{}" }),
      },
      { authError: signedOut, sessionAuth: true },
    );
    return parseSearch(body, entity);
  }

  async function get(path, bytes = false) {
    return request(
      `https://${host}${path}`,
      { credentials: "include", redirect: "manual", headers: { Accept: bytes ? "*/*" : "application/json" } },
      { authError: signedOut, sessionAuth: true, bytes },
    );
  }

  return {
    // One page: { records, total }. total is null when the body doesn't say.
    searchPage: search,

    // Resolves when the session works; throws AuthError("session") when not.
    async checkSession() {
      await search("Job", 1);
    },

    // Attachment listings. Checked live (2026-11-13): these take an
    // *estimate* id; a job id gets HTTP 500. The documents list holds the
    // estimate's job's files (ownerType 1 = job); measurements belong to the
    // job's location (ownerType 2). Each row gets fileRef, the value
    // /Attach/Job?name= takes.
    async measurements(estimateId) {
      const body = await get(`/app/api/fam/documentManagement/1/${encodeURIComponent(estimateId)}/measurements`);
      return (Array.isArray(body) ? body : []).flatMap((report) => {
        const files = Array.isArray(report.files) ? report.files.filter((file) => file?.fileUrl) : [];
        const { files: _files, ...rest } = report;
        return files.map((file) => ({ ...rest, file, fileRef: file.fileUrl }));
      });
    },

    async documents(estimateId) {
      const items = [];
      for (let start = 0; ; ) {
        const body = await get(
          `/app/api/fam/documentManagement/7/${encodeURIComponent(estimateId)}/documents?size=1000&startIndex=${start}`,
        );
        const page = Array.isArray(body?.items) ? body.items : [];
        items.push(...page);
        start += page.length;
        if (!page.length || body.isLast !== false) break;
      }
      return items.filter((item) => item?.filename).map((item) => ({ ...item, fileRef: item.filename }));
    },

    // { bytes, type, disposition } for one attachment.
    download(fileRef) {
      return get(`/Attach/Job?name=${encodeURIComponent(fileRef)}`, true);
    },
  };
}

export function parseSearch(body, entity = "search") {
  const records = Array.isArray(body) ? body : findList(body);
  if (!records) throw new RequestError(`The ${entity} search came back without a list.`);
  const total = body && !Array.isArray(body) ? findTotal(body) : null;
  return { records: records.filter((row) => row && typeof row === "object" && !Array.isArray(row)), total };
}

function findList(body, depth = 0) {
  if (!body || typeof body !== "object" || depth > 2) return null;
  for (const key of LIST_KEYS) if (Array.isArray(body[key])) return body[key];
  for (const value of Object.values(body)) {
    if (Array.isArray(value) && value.every((row) => row && typeof row === "object")) return value;
  }
  for (const value of Object.values(body)) {
    const nested = value && typeof value === "object" && !Array.isArray(value) ? findList(value, depth + 1) : null;
    if (nested) return nested;
  }
  return null;
}

function findTotal(body, depth = 0) {
  if (!body || typeof body !== "object" || depth > 2) return null;
  for (const key of TOTAL_KEYS) if (Number.isInteger(body[key])) return body[key];
  for (const value of Object.values(body)) {
    const nested = value && typeof value === "object" && !Array.isArray(value) ? findTotal(value, depth + 1) : null;
    if (nested !== null) return nested;
  }
  return null;
}

// A stable identity for a record, to notice a server that ignores `page`.
export function recordId(record) {
  for (const key of ["Id", "id", "ID", "Number", "number"]) {
    if (record[key] !== undefined && record[key] !== null) return String(record[key]);
  }
  return JSON.stringify(record);
}
