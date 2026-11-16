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

const FILE_FIELDS = "id fileName fileSize contentType createdAt description downloadUrl";
const filesSelection = (after) =>
  `noteAttachments(first: ${FILES_PER_RECORD}${after ? `, after: ${JSON.stringify(after)}` : ""}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${FILE_FIELDS} } }`;

export function createJobberClient({ fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now, delayMs, onWait = () => {} } = {}) {
  const request = createRequester({ fetch, sleep, now, delayMs, onWait, service: "Jobber" });
  // Files are presigned S3 links: no cookie, no spacing.
  const fileRequest = createRequester({ fetch, sleep, now, delayMs: 0, onWait, service: "Jobber" });
  const signedOut = () => new AuthError("session", "You're not signed in to Jobber in this browser.");
  let budget = null; // { available, restoreRate } from the last response

  async function query(text, requestedCost = 0) {
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
      if (!body?.data) throw new RequestError(`Jobber answered with an error: ${body?.errors?.[0]?.message ?? "no data"}`);
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

  return {
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
