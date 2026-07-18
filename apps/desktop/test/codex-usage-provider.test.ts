import assert from "node:assert/strict";
import test from "node:test";
import { readCodexAuth } from "../lifecycle-sidecar/codex-usage/auth.ts";
import { CodexUsageProvider } from "../lifecycle-sidecar/codex-usage/provider.ts";

const testToken = "test-token-must-never-leak";

test("auth reader distinguishes missing, permission, read, malformed JSON, and missing token failures", async () => {
  await assert.rejects(() => readCodexAuth({ readText: rejectingRead("ENOENT") }), hasCode("AUTH_FILE_NOT_FOUND"));
  await assert.rejects(() => readCodexAuth({ readText: rejectingRead("EACCES") }), hasCode("AUTH_FILE_PERMISSION_DENIED"));
  await assert.rejects(() => readCodexAuth({ readText: rejectingRead("EIO") }), hasCode("AUTH_FILE_READ_FAILED"));
  await assert.rejects(() => readCodexAuth({ readText: async () => "{" }), hasCode("AUTH_FILE_INVALID_JSON"));
  await assert.rejects(() => readCodexAuth({ readText: async () => JSON.stringify({ tokens: {} }) }), hasCode("AUTH_TOKEN_MISSING"));
});

test("auth reader returns only the access token and optional account id", async () => {
  const auth = await readCodexAuth({
    readText: async () => JSON.stringify({
      tokens: { access_token: testToken, account_id: "account-1", refresh_token: "do-not-return" },
      email: "private@example.com"
    })
  });
  assert.deepEqual(auth, { accessToken: testToken, accountId: "account-1" });
  assert.equal(JSON.stringify(auth).includes("private@example.com"), false);
  assert.equal(JSON.stringify(auth).includes("do-not-return"), false);
});

test("provider re-reads auth on every refresh and sends only required headers", async () => {
  let authReads = 0;
  const requests: Array<{ input: string; headers: Record<string, string> }> = [];
  const provider = new CodexUsageProvider({
    readAuth: async () => ({ accessToken: `rotated-${++authReads}`, accountId: authReads === 1 ? "account-1" : null }),
    fetchImpl: async (input, init) => {
      requests.push({ input, headers: init.headers });
      return okResponse(payload());
    },
    now: () => new Date("2026-07-18T00:00:00.000Z")
  });

  await provider.fetchUsage();
  await provider.fetchUsage();
  assert.equal(authReads, 2);
  assert.equal(requests[0].headers.Authorization, "Bearer rotated-1");
  assert.equal(requests[0].headers["ChatGPT-Account-Id"], "account-1");
  assert.equal(requests[1].headers.Authorization, "Bearer rotated-2");
  assert.equal("ChatGPT-Account-Id" in requests[1].headers, false);
});

for (const [status, code] of [
  [401, "HTTP_UNAUTHORIZED"],
  [403, "HTTP_FORBIDDEN"],
  [429, "HTTP_RATE_LIMITED"],
  [500, "HTTP_SERVER_ERROR"]
] as const) {
  test(`provider safely classifies HTTP ${status}`, async () => {
    const provider = providerWithFetch(async () => ({ ok: false, status, json: async () => ({}) }));
    await assert.rejects(() => provider.fetchUsage(), hasCode(code));
  });
}

test("provider classifies timeout, network, invalid JSON, and schema mismatch without leaking credentials", async () => {
  const aborted = new Error(`Abort ${testToken}`);
  aborted.name = "AbortError";
  const cases: Array<[() => Promise<Pick<Response, "ok" | "status" | "json">>, string]> = [
    [async () => { throw aborted; }, "REQUEST_TIMEOUT"],
    [async () => { throw new Error(`network ${testToken}`); }, "NETWORK_UNAVAILABLE"],
    [async () => ({ ok: true, status: 200, json: async () => { throw new Error(`JSON ${testToken}`); } }), "RESPONSE_INVALID_JSON"],
    [async () => okResponse({ plan_type: "plus" }), "PAYLOAD_SCHEMA_MISMATCH"]
  ];

  for (const [fetchImpl, code] of cases) {
    try {
      await providerWithFetch(fetchImpl).fetchUsage();
      assert.fail("expected provider failure");
    } catch (error) {
      assert.equal((error as { safe?: { code?: string } }).safe?.code, code);
      assert.equal(String(error).includes(testToken), false);
      assert.equal(JSON.stringify(error).includes(testToken), false);
    }
  }
});

function providerWithFetch(fetchImpl: () => Promise<Pick<Response, "ok" | "status" | "json">>) {
  return new CodexUsageProvider({
    readAuth: async () => ({ accessToken: testToken, accountId: "account-1" }),
    fetchImpl,
    now: () => new Date("2026-07-18T00:00:00.000Z")
  });
}

function payload() {
  return {
    plan_type: "plus",
    rate_limit: { secondary: { remaining_percent: 40, window_seconds: 604_800 } }
  };
}

function okResponse(value: unknown): Pick<Response, "ok" | "status" | "json"> {
  return { ok: true, status: 200, json: async () => value };
}

function rejectingRead(code: string): () => Promise<string> {
  return async () => { throw Object.assign(new Error("safe fake error"), { code }); };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => (error as { safe?: { code?: string } }).safe?.code === code;
}
