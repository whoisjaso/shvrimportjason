import assert from "node:assert/strict";
import { test } from "node:test";

import { READ_ONLY_ROLE, RequestError, SHVR_KEY_NOTE, findOrCreateApiKey } from "../../extension/lib/hcp.js";

function fakeClient(keys, { created } = {}) {
  const calls = [];
  return {
    calls,
    async apiKeys() {
      calls.push("list");
      return keys;
    },
    async createApiKey(fields) {
      calls.push(["create", fields]);
      if (created === undefined) throw new RequestError("/alpha/organization/api_keys returned HTTP 403.", 403);
      keys.push(created);
      return created;
    },
  };
}

test("reuses the key whose note mentions SHVR, preferring a read-only one", async () => {
  const client = fakeClient([
    { api_key: "zapier", note: "Zapier", role: "API_KEY_ADMIN", enabled: true },
    { api_key: "shvr-admin", note: "SHVR", role: "API_KEY_ADMIN", enabled: true },
    { api_key: "shvr-reader", note: "shvr export", role: READ_ONLY_ROLE, enabled: true },
  ]);
  assert.deepEqual(await findOrCreateApiKey(client), { apiKey: "shvr-reader", created: false });
  assert.deepEqual(client.calls, ["list"]);
});

test("uses an SHVR key of any role when it's the only one", async () => {
  const client = fakeClient([{ api_key: "shvr-admin", note: "SHVR", role: "API_KEY_ADMIN", enabled: true }]);
  assert.deepEqual(await findOrCreateApiKey(client), { apiKey: "shvr-admin", created: false });
});

test("creates a read-only SHVR key when none exists", async () => {
  const client = fakeClient([{ api_key: "zapier", note: "Zapier", role: "API_KEY_ADMIN" }], {
    created: { api_key: "new-key", note: SHVR_KEY_NOTE, role: READ_ONLY_ROLE },
  });
  assert.deepEqual(await findOrCreateApiKey(client), { apiKey: "new-key", created: true });
  assert.deepEqual(client.calls[1], ["create", { note: SHVR_KEY_NOTE }]);
});

test("a user who can't manage keys gets the error, so the page can ask for one", async () => {
  await assert.rejects(findOrCreateApiKey(fakeClient([])), RequestError);
});
