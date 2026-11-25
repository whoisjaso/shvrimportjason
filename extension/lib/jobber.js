// Jobber's GraphQL API, called with the browser's signed-in session (the
// _jobber_session_id cookie on .getjobber.com). No API key. Checked live
// 2026-11-16: the cookie alone authenticates; signed out, every field comes
// back with an UNAUTHENTICATED error (still HTTP 200).
//
// Cost: each query's requested cost must fit in a 100,000-point budget that
// refills at 500 points a second; only the actual cost (about one point per
// field per record) is spent. Every response reports the budget left.

import { AuthError, RequestError, createRequester } from "./hcp.js";

export const GRAPHQL_URL = "https://api.getjobber.com/api/graphql?location=j";
export const GRAPHQL_VERSION = "2026-11-10";
export const SIGN_IN_URL = "https://secure.getjobber.com/login";
export const PAGE_SIZE = 50;
const FILES_PER_RECORD = 100;

const ADDRESS = "street1 street2 city province postalCode country";

// Each search: the connection on Query, the single-record query (for
// paging a record's files), the field picked for folder names, and the
// fields to export. Computed fields that cost seconds per page
// (visit/invoice rollups, follow-up schedules, client hub state) are left out.
export const ENTITIES = [
  {
    key: "jobs",
    label: "jobs",
    single: "job",
    number: "jobNumber",
    fields: `id jobNumber title jobStatus jobType billingType source instructions startAt endAt completedAt createdAt updatedAt subtotal total discountAmount jobberWebUri client { id name } property { id address { ${ADDRESS} } } quote { id quoteNumber }`,
  },
  {
    key: "clients",
    label: "clients",
    single: "client",
    number: "name",
    fields: `id name firstName lastName companyName isCompany isLead isArchived title email phone leadSource balance createdAt updatedAt jobberWebUri billingAddress { ${ADDRESS} } tags { nodes { label } }`,
  },
  {
    key: "quotes",
    label: "quotes",
    single: "quote",
    number: "quoteNumber",
    fields: `id quoteNumber title quoteStatus message lostReason sentAt createdAt updatedAt jobberWebUri amounts { subtotal discountAmount taxAmount total depositAmount } client { id name } property { id address { ${ADDRESS} } } request { id }`,
  },
  {
    key: "invoices",
    label: "invoices",
    single: "invoice",
    number: "invoiceNumber",
    fields: `id invoiceNumber subject invoiceStatus issuedDate dueDate receivedDate message invoiceNet createdAt updatedAt jobberWebUri amounts { subtotal discountAmount taxAmount total paymentsTotal invoiceBalance tipsTotal depositAmount } client { id name } jobs { nodes { id jobNumber } }`,
  },
  {
    key: "requests",
    label: "requests",
    single: "request",
    number: "id",
    fields: `id title requestStatus source companyName contactName email phone lostReason createdAt updatedAt jobberWebUri client { id name } property { id address { ${ADDRESS} } } amounts { total }`,
  },
];

// Records that carry line items (the products and services sold), and how
// many come along per record before the rest are paged by id.
export const LINE_ITEM_ENTITIES = new Set(["jobs", "quotes", "invoices"]);
export const LINE_ITEMS_PER_RECORD = 25;
// Deep enough to unwrap [Type!]! to its named type.
const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
// A type the way GraphQL writes it: [QuoteLineItem!]!
const typeText = (type) => (!type ? "" : type.kind === "NON_NULL" ? `${typeText(type.ofType)}!` : type.kind === "LIST" ? `[${typeText(type.ofType)}]` : (type.name ?? ""));
const namedType = (type) => {
  let named = type;
  while (named?.ofType) named = named.ofType;
  return named ?? {};
};
const typeName = (entity) => entity.single[0].toUpperCase() + entity.single.slice(1);

const FILE_FIELDS = "id fileName fileSize contentType createdAt description downloadUrl";
const filesSelection = (after) =>
  `noteAttachments(first: ${FILES_PER_RECORD}${after ? `, after: ${JSON.stringify(after)}` : ""}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${FILE_FIELDS} } }`;

export function createJobberClient({ fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now, delayMs, onWait = () => {} } = {}) {
  const request = createRequester({ fetch, sleep, now, delayMs, onWait, service: "Jobber" });
  // Files are presigned S3 links: no cookie, no spacing.
  const fileRequest = createRequester({ fetch, sleep, now, delayMs: 0, onWait, service: "Jobber" });
  const signedOut = () => new AuthError("session", "You're not signed in to Jobber in this browser.");
  let budget = null; // { available, restoreRate } from the last response

  // strict: any GraphQL error fails the query, even when data came back.
  async function query(text, requestedCost = 0, { strict = false } = {}) {
    for (let throttled = 0; ; throttled += 1) {
      // Wait for the budget to cover this query instead of being refused.
      if (budget && requestedCost > budget.available) {
        const seconds = Math.ceil((requestedCost - budget.available) / budget.restoreRate);
        onWait({ reason: "rate_limited", seconds });
        await sleep(seconds * 1000);
        budget = null;
      }
      const body = await request(
        GRAPHQL_URL,
        {
          method: "POST",
          credentials: "include",
          redirect: "manual",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Jobber-GraphQL-Version": GRAPHQL_VERSION },
          body: JSON.stringify({ query: text }),
        },
        { authError: signedOut, sessionAuth: true },
      );
      const status = body?.extensions?.cost?.throttleStatus;
      if (status) budget = { available: status.currentlyAvailable, restoreRate: status.restoreRate || 500 };
      const codes = (body?.errors ?? []).map((error) => error?.extensions?.code);
      if (codes.includes("UNAUTHENTICATED")) throw signedOut();
      if (codes.includes("THROTTLED") && throttled < 6) {
        const requested = body.extensions?.cost?.requestedQueryCost ?? requestedCost;
        const seconds = Math.max(1, Math.ceil((requested - (budget?.available ?? 0)) / (budget?.restoreRate ?? 500)));
        onWait({ reason: "rate_limited", seconds });
        await sleep(seconds * 1000);
        continue;
      }
      if (!body?.data || (strict && body.errors?.length)) throw new RequestError(`Jobber answered with an error: ${body?.errors?.[0]?.message ?? "no data"}`);
      return body.data;
    }
  }

  // The rest of one record's files, past the first page.
  async function moreFiles(entity, id, connection) {
    const files = [...connection.nodes];
    let { hasNextPage, endCursor } = connection.pageInfo ?? {};
    while (hasNextPage) {
      const data = await query(`{ ${entity.single}(id: ${JSON.stringify(id)}) { ${filesSelection(endCursor)} } }`, FILES_PER_RECORD * 5);
      const next = data[entity.single]?.noteAttachments;
      if (!next) break;
      files.push(...next.nodes);
      ({ hasNextPage, endCursor } = next.pageInfo ?? {});
    }
    return files;
  }

  const types = new Map(); // type name -> its fields, asked once
  async function typeFields(name) {
    if (!types.has(name)) {
      const data = await query(`{ __type(name: ${JSON.stringify(name)}) { fields { name args { name defaultValue type { ${TYPE_REF} } } type { ${TYPE_REF} } } } }`, 0, { strict: true });
      types.set(name, data.__type?.fields ?? []);
    }
    return types.get(name);
  }

  const lineItemsSelection = (fields, after) =>
    `lineItems(first: ${LINE_ITEMS_PER_RECORD}${after ? `, after: ${JSON.stringify(after)}` : ""}) { pageInfo { hasNextPage endCursor } nodes { ${fields.join(" ")} } }`;
  // About one point per field per line item, plus the connection itself.
  const lineItemsCost = (records, fields) => records * (LINE_ITEMS_PER_RECORD * (fields.length + 1) + 4);

  // One record's line items from `after` on (all of them when it's null).
  async function lineItemsOf(entity, id, fields, after = null) {
    const items = [];
    for (let cursor = after, first = true; first || cursor; first = false) {
      const data = await query(`{ ${entity.single}(id: ${JSON.stringify(id)}) { ${lineItemsSelection(fields, cursor)} } }`, lineItemsCost(1, fields), { strict: true });
      const connection = data[entity.single]?.lineItems;
      if (!connection || !Array.isArray(connection.nodes)) break;
      items.push(...connection.nodes.filter(Boolean));
      cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    }
    return items;
  }

  return {
    // The plain (scalar and enum) fields of this record type's line items,
    // read from Jobber's own schema so no field name is guessed; null when
    // the record type has no lineItems connection.
    async lineItemFields(entity) {
      const field = (await typeFields(typeName(entity))).find((f) => f.name === "lineItems");
      const connection = namedType(field?.type).name;
      if (!connection) return null;
      const nodes = (await typeFields(connection)).find((f) => f.name === "nodes");
      const item = namedType(nodes?.type).name;
      if (!item) return null;
      const fields = (await typeFields(item))
        .filter((f) => ["SCALAR", "ENUM"].includes(namedType(f.type).kind) && !(f.args ?? []).some((arg) => arg.type?.kind === "NON_NULL"))
        .map((f) => f.name);
      return fields.length ? fields : null;
    },

    // What Jobber's schema says about this record type and its line items:
    // every field of the record type, of its lineItems connection, of the
    // line item type and of its amounts type, as { type, field, field_type,
    // arguments } rows. It holds no account data. It is there to show which
    // other fields or connections could carry lines that lineItems doesn't,
    // and whether lineItems takes a filter.
    async schemaRows(entity) {
      const rows = [];
      const describe = async (name) => {
        if (!name || rows.some((row) => row.type === name)) return [];
        const fields = await typeFields(name);
        for (const field of fields) {
          const args = (field.args ?? []).map((arg) => `${arg.name}: ${typeText(arg.type)}${arg.defaultValue == null ? "" : ` = ${arg.defaultValue}`}`);
          rows.push({ type: name, field: field.name, field_type: typeText(field.type), arguments: args.join(", ") });
        }
        return fields;
      };
      const record = await describe(typeName(entity));
      const connection = await describe(namedType(record.find((f) => f.name === "lineItems")?.type).name);
      await describe(namedType(connection.find((f) => f.name === "nodes")?.type).name);
      await describe(namedType(record.find((f) => f.name === "amounts")?.type).name);
      return rows;
    },

    // The line items of one page of records: { [record id]: [item] }. `after`
    // is the cursor that page was listed from. A record that isn't on the
    // page any more, or has more items than came along, is read by id.
    async lineItems(entity, after, ids, fields) {
      const args = `first: ${PAGE_SIZE}${after ? `, after: ${JSON.stringify(after)}` : ""}`;
      const data = await query(`{ ${entity.key}(${args}) { nodes { id ${lineItemsSelection(fields)} } } }`, lineItemsCost(PAGE_SIZE, fields), { strict: true });
      const nodes = data[entity.key]?.nodes;
      if (!Array.isArray(nodes)) throw new RequestError(`The ${entity.label} line items came back without their records.`);
      const byId = new Map(nodes.filter(Boolean).map((node) => [node.id, node.lineItems]));
      const out = {};
      for (const id of ids) {
        const connection = byId.get(id);
        if (!connection || !Array.isArray(connection.nodes)) {
          out[id] = await lineItemsOf(entity, id, fields);
          continue;
        }
        const items = connection.nodes.filter(Boolean);
        out[id] = connection.pageInfo?.hasNextPage ? [...items, ...(await lineItemsOf(entity, id, fields, connection.pageInfo.endCursor))] : items;
      }
      return out;
    },

    // { id, name } of the signed-in account; throws AuthError("session").
    async account() {
      return (await query("{ account { id name } }")).account;
    },

    // One page: { records, total, endCursor, hasNextPage }. With files, each
    // record carries files: [file] (every one of them, paged as needed).
    async listPage(entity, after, withFiles) {
      const args = `first: ${PAGE_SIZE}${after ? `, after: ${JSON.stringify(after)}` : ""}`;
      const selection = `${entity.fields}${withFiles ? ` ${filesSelection()}` : ""}`;
      // Jobber's estimate for a page with files is about 40,000 points.
      const data = await query(`{ ${entity.key}(${args}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${selection} } } }`, withFiles ? 48000 : 4000);
      const connection = data[entity.key];
      if (!connection || !Array.isArray(connection.nodes)) throw new RequestError(`The ${entity.label} list came back without its records.`);
      const records = [];
      for (const node of connection.nodes) {
        if (!node || typeof node !== "object") continue;
        const { noteAttachments, ...record } = node;
        if (withFiles) {
          record.files = noteAttachments?.totalCount > noteAttachments.nodes.length ? await moreFiles(entity, record.id, noteAttachments) : (noteAttachments?.nodes ?? []);
        }
        records.push(record);
      }
      return { records, total: connection.totalCount ?? null, endCursor: connection.pageInfo?.endCursor ?? null, hasNextPage: Boolean(connection.pageInfo?.hasNextPage) };
    },

    // { bytes, type, disposition } for one file's presigned link.
    download(url) {
      return fileRequest(url, { credentials: "omit" }, { authError: () => new RequestError("The file link was refused.", 401), bytes: true });
    },
  };
}
