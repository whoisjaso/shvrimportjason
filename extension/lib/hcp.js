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

export function createClient({
  apiKey,
  fetch = globalThis.fetch.bind(globalThis),
  sleep = realSleep,
  now = () => Date.now(),
  delayMs = DEFAULT_DELAY_MS,
  publicBase = PUBLIC_BASE,
  privateBase = PRIVATE_BASE,
  onWait = () => {},
} = {}) {
  let lastStart = null;

  async function throttle() {
    if (lastStart !== null) {
      const remaining = lastStart + delayMs - now();
      if (remaining > 0) await sleep(remaining);
    }
    lastStart = now();
  }

  async function getJson(url, init, surface) {
    let rateLimited = 0;
    let serverFailures = 0;
    for (;;) {
      await throttle();
      let response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        serverFailures += 1;
        if (serverFailures > MAX_SERVER_RETRIES) {
          throw new RequestError(`Could not reach Housecall Pro (${error.message}).`);
        }
        await backoff(serverFailures, "connection problem");
        continue;
      }

      // A signed-out browser is redirected to the login page instead of
      // getting JSON; the private calls ask not to follow redirects.
      if (response.type === "opaqueredirect" || response.status === 401) {
        throw authError(surface);
      }
      if (response.ok) {
        const text = await response.text();
        if (!text.trim()) return {};
        try {
          return JSON.parse(text);
        } catch {
          if (surface === "private") throw authError(surface);
          throw new RequestError(`${pathOf(url)} returned something that isn't JSON.`, response.status);
        }
      }
      if (response.status === 429) {
        rateLimited += 1;
        if (rateLimited > MAX_RATE_LIMIT_RETRIES) {
          throw new RequestError("Housecall Pro kept asking us to slow down.", 429);
        }
        const seconds = retryAfter(response.headers.get("Retry-After"));
        onWait({ reason: "rate_limited", seconds });
        await sleep(seconds * 1000);
        continue;
      }
      if (response.status >= 500) {
        serverFailures += 1;
        if (serverFailures > MAX_SERVER_RETRIES) {
          throw new RequestError(`Housecall Pro had a problem (HTTP ${response.status}).`, response.status);
        }
        await backoff(serverFailures, `HTTP ${response.status}`);
        continue;
      }
      throw new RequestError(`${pathOf(url)} returned HTTP ${response.status}.`, response.status);
    }
  }

  async function backoff(attempt, reason) {
    const seconds = 2 ** attempt;
    onWait({ reason, seconds });
    await sleep(seconds * 1000);
  }

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

  return {
    async company() {
      const body = await getPublic("/company");
      return body && typeof body === "object" ? body : {};
    },

    // One page of jobs: { jobs, totalPages }. totalPages is null when the
    // response doesn't say; then a short page is the last one.
    async jobsPage(page) {
      const query = new URLSearchParams({ page: String(page), page_size: String(JOBS_PAGE_SIZE) });
      const body = await getPublic(`/jobs?${query}`);
      const records = Array.isArray(body?.jobs) ? body.jobs : body?.data;
      if (!Array.isArray(records)) throw new RequestError("The jobs list came back empty-handed.");
      const total = Number.isInteger(body.total_pages) ? body.total_pages : body.meta?.total_pages;
      return {
        jobs: records.filter((record) => record && typeof record === "object"),
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
  };
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
