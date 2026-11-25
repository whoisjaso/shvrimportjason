// Housecall Pro calls for the export: the public API with the user's API key,
// the private /alpha/ API with the browser's own signed-in session.
// Requests start at least `delayMs` apart; 429s wait for Retry-After, and
// 5xx answers and dropped connections back off exponentially.

export const PUBLIC_BASE = "https://api.housecallpro.com";
export const PRIVATE_BASE = "https://pro.housecallpro.com";
export const JOBS_PAGE_SIZE = 100;
export const DEFAULT_DELAY_MS = 100;

const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_SERVER_RETRIES = 4;
const DEFAULT_RETRY_AFTER_S = 5;
const MATERIAL_EXPAND = ["material_vendor", "material_purchase_status", "material_source"];

// kind: "api_key" (the public API refused the key) or "session" (the
// browser isn't signed in to Housecall Pro). Either one stops the export.
export class AuthError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "AuthError";
    this.kind = kind;
  }
}

// One request failed for good. `status` is the HTTP status, or 0 when the
// server never answered.
export class RequestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Throttled JSON requests with retries, shared by the Housecall Pro and
// ServiceTitan clients. request(url, init, { authError, sessionAuth }):
// authError() builds the AuthError for a 401 or a login redirect; with
// sessionAuth, a 200 that isn't JSON (a login page) counts as signed out too.
export function createRequester({
  fetch = globalThis.fetch.bind(globalThis),
  sleep = realSleep,
  now = () => Date.now(),
  delayMs = DEFAULT_DELAY_MS,
  onWait = () => {},
  service = "Housecall Pro",
} = {}) {
  let lastStart = null;

  async function throttle() {
    if (lastStart !== null) {
      const remaining = lastStart + delayMs - now();
      if (remaining > 0) await sleep(remaining);
    }
    lastStart = now();
  }

  async function backoff(attempt, reason) {
    const seconds = 2 ** attempt;
    onWait({ reason, seconds });
    await sleep(seconds * 1000);
  }

  return async function request(url, init, { authError, sessionAuth = false, bytes = false }) {
    let rateLimited = 0;
    let serverFailures = 0;
    // A dropped connection, before the headers or while reading the body.
    const connectionLost = async (error) => {
      serverFailures += 1;
      if (serverFailures > MAX_SERVER_RETRIES) {
        throw new RequestError(`Could not reach ${service} (${error.message}).`);
      }
      await backoff(serverFailures, "connection problem");
    };
    for (;;) {
      await throttle();
      let response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        await connectionLost(error);
        continue;
      }

      // A signed-out browser is redirected to the login page instead of
      // getting JSON; session calls ask not to follow redirects.
      if (response.type === "opaqueredirect" || response.status === 401) throw authError();
      if (response.ok && bytes) {
        // A login page served in place of a file means the session ended.
        if (sessionAuth && (response.headers.get("Content-Type") ?? "").includes("text/html")) throw authError();
        let body;
        try {
          body = new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          await connectionLost(error);
          continue;
        }
        return {
          bytes: body,
          type: response.headers.get("Content-Type") ?? "",
          disposition: response.headers.get("Content-Disposition") ?? "",
        };
      }
      if (response.ok) {
        let text;
        try {
          text = await response.text();
        } catch (error) {
          await connectionLost(error);
          continue;
        }
        if (!text.trim()) return {};
        try {
          return JSON.parse(text);
        } catch {
          if (sessionAuth) throw authError();
          throw new RequestError(`${pathOf(url)} returned something that isn't JSON.`, response.status);
        }
      }
      if (response.status === 429) {
        rateLimited += 1;
        if (rateLimited > MAX_RATE_LIMIT_RETRIES) {
          throw new RequestError(`${service} kept asking us to slow down.`, 429);
        }
        const seconds = retryAfter(response.headers.get("Retry-After"));
        onWait({ reason: "rate_limited", seconds });
        await sleep(seconds * 1000);
        continue;
      }
      if (response.status >= 500) {
        serverFailures += 1;
        if (serverFailures > MAX_SERVER_RETRIES) {
          throw new RequestError(`${service} had a problem (HTTP ${response.status}).`, response.status);
        }
        await backoff(serverFailures, `HTTP ${response.status}`);
        continue;
      }
      throw new RequestError(`${pathOf(url)} returned HTTP ${response.status}.`, response.status);
    }
  };
}

export function createClient({
  apiKey,
  fetch,
  sleep,
  now,
  delayMs,
  publicBase = PUBLIC_BASE,
  privateBase = PRIVATE_BASE,
  onWait,
} = {}) {
  const request = createRequester({ fetch, sleep, now, delayMs, onWait });
  const getJson = (url, init, surface) =>
    request(url, init, { authError: () => authError(surface), sessionAuth: surface === "private" });

  function getPublic(path) {
    return getJson(
      `${publicBase}${path}`,
      { headers: { Authorization: `Token ${apiKey}`, Accept: "application/json" } },
      "public",
    );
  }

  function getPrivate(path) {
    return getJson(
      `${privateBase}${path}`,
      { headers: { Accept: "application/json" }, credentials: "include", redirect: "manual" },
      "private",
    );
  }

  function postPrivateForm(path, fields) {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    return getJson(
      `${privateBase}${path}`,
      { method: "POST", body, headers: { Accept: "application/json" }, credentials: "include", redirect: "manual" },
      "private",
    );
  }

  return {
    async company() {
      const body = await getPublic("/company");
      return body && typeof body === "object" ? body : {};
    },

    // One page of "jobs" or "estimates": { records, totalPages }. totalPages
    // is null when the response doesn't say; then a short page is the last one.
    async listPage(resource, page) {
      const query = new URLSearchParams({ page: String(page), page_size: String(JOBS_PAGE_SIZE) });
      const body = await getPublic(`/${resource}?${query}`);
      const records = Array.isArray(body?.[resource]) ? body[resource] : body?.data;
      if (!Array.isArray(records)) throw new RequestError(`The ${resource} list came back empty-handed.`);
      const total = Number.isInteger(body.total_pages) ? body.total_pages : body.meta?.total_pages;
      return {
        records: records.filter((record) => record && typeof record === "object"),
        totalPages: Number.isInteger(total) ? total : null,
      };
    },

    // Resolves when the browser holds a working Housecall Pro session;
    // throws AuthError("session") when it doesn't.
    async checkSession() {
      await getPrivate("/alpha/organization/job_line_item_details_settings");
    },

    async materials(jobId) {
      const query = new URLSearchParams([["job_uuid", jobId], ...MATERIAL_EXPAND.map((name) => ["expand[]", name])]);
      return listData(await getPrivate(`/alpha/job_costing/job_input_materials?${query}`));
    },

    async miscellaneousItems(jobId) {
      return listData(await getPrivate(`/alpha/jobs/${encodeURIComponent(jobId)}/miscellaneous_items`));
    },

    // The company's enabled public-API keys, as listed on My Apps › API Key
    // Management: [{ id, api_key, note, role, kind, enabled }]. Only admins
    // may read them (others get 401/403).
    async apiKeys() {
      return listData(await getPrivate("/alpha/organization/api_keys?enabled=true&kind=API_ACCESS"));
    },

    // Generate a key the way the API Key Management page does (form post).
    async createApiKey({ note, role = READ_ONLY_ROLE }) {
      return postPrivateForm("/alpha/organization/api_keys", { note, kind: "API_ACCESS", role });
    },
  };
}

export const READ_ONLY_ROLE = "API_KEY_READER";
export const SHVR_KEY_NOTE = "SHVR Data Export";

// The key this extension uses: an enabled key whose note mentions SHVR
// (read-only preferred), or a new read-only one. Returns { apiKey, created }.
// Throws a RequestError when the signed-in user can't manage keys.
export async function findOrCreateApiKey(client) {
  const shvr = (keys) =>
    keys
      .filter((key) => key.enabled !== false && typeof key.api_key === "string" && /shvr/i.test(key.note ?? ""))
      .sort((a, b) => Number(b.role === READ_ONLY_ROLE) - Number(a.role === READ_ONLY_ROLE));
  const existing = shvr(await client.apiKeys())[0];
  if (existing) return { apiKey: existing.api_key, created: false };

  const made = await client.createApiKey({ note: SHVR_KEY_NOTE });
  const record = made?.data && !Array.isArray(made.data) ? made.data : made;
  if (typeof record?.api_key === "string") return { apiKey: record.api_key, created: true };
  // The create response didn't carry the key; it's in the list now.
  const listed = shvr(await client.apiKeys())[0];
  if (!listed) throw new RequestError("Housecall Pro didn't return the new API key.");
  return { apiKey: listed.api_key, created: true };
}

function authError(surface) {
  return surface === "public"
    ? new AuthError("api_key", "Housecall Pro didn't accept the API key.")
    : new AuthError("session", "You're not signed in to Housecall Pro in this browser.");
}

function listData(body) {
  if (!body || !Array.isArray(body.data)) throw new RequestError("A costs list came back without its items.");
  return body.data.filter((row) => row && typeof row === "object");
}

function retryAfter(value) {
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? Math.max(1, seconds) : DEFAULT_RETRY_AFTER_S;
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
