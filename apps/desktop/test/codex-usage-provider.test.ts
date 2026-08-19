import assert from "node:assert/strict";
import test from "node:test";
import { readCodexAuth } from "../lifecycle-sidecar/codex-usage/auth.ts";
import { CodexUsageProvider } from "../lifecycle-sidecar/codex-usage/provider.ts";
import {
  createCodexUsageFetch,
  parseWindowsSystemProxySettings
} from "../lifecycle-sidecar/codex-usage/windows-system-proxy.ts";

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

test("auth reader exposes only a bounded local plan observation from matching JWT claims", async () => {
  const idToken = fakeJwt({
    iat: 1_784_352_400,
    exp: 1_784_438_800,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_plan_type: "plus",
      chatgpt_user_id: "must-not-return"
    }
  });
  const auth = await readCodexAuth({
    readText: async () => JSON.stringify({
      tokens: { id_token: idToken, access_token: testToken, account_id: "account-1" }
    })
  });
  assert.deepEqual(auth.localPlan, {
    planTypeRaw: "plus",
    observedAt: "2026-07-18T05:26:40.000Z",
    expiresAt: "2026-07-19T05:26:40.000Z"
  });
  assert.equal(JSON.stringify(auth).includes("must-not-return"), false);

  const mismatched = await readCodexAuth({
    readText: async () => JSON.stringify({
      tokens: { id_token: idToken, access_token: testToken, account_id: "other-account" }
    })
  });
  assert.equal(mismatched.localPlan, undefined);
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

test("provider falls back to an unexpired local Codex plan when Windows cannot reach usage", async () => {
  const aborted = new Error("timeout");
  aborted.name = "AbortError";
  const provider = new CodexUsageProvider({
    readAuth: async () => ({
      accessToken: testToken,
      accountId: "account-1",
      localPlan: {
        planTypeRaw: "plus",
        observedAt: "2026-07-18T01:00:00.000Z",
        expiresAt: "2026-07-19T01:00:00.000Z"
      }
    }),
    fetchImpl: async () => { throw aborted; },
    now: () => new Date("2026-07-18T02:00:00.000Z")
  });

  assert.deepEqual(await provider.fetchUsage(), {
    source: "local_auth",
    planTypeRaw: "plus",
    planDisplayName: null,
    membershipVerified: false,
    weekly: null,
    observedAt: "2026-07-18T01:00:00.000Z",
    fetchedAt: "2026-07-18T02:00:00.000Z",
    stale: false
  });
});

test("provider keeps a recently expired local plan as stale and rejects it after a bounded grace period", async () => {
  const aborted = new Error("timeout");
  aborted.name = "AbortError";
  const providerAt = (now: string) => new CodexUsageProvider({
    readAuth: async () => ({
      accessToken: testToken,
      accountId: "account-1",
      localPlan: {
        planTypeRaw: "prolite",
        observedAt: "2026-07-18T23:00:00.000Z",
        expiresAt: "2026-07-19T00:00:00.000Z"
      }
    }),
    fetchImpl: async () => { throw aborted; },
    now: () => new Date(now)
  });

  const recent = await providerAt("2026-07-19T02:00:00.000Z").fetchUsage();
  assert.equal(recent.source, "local_auth");
  assert.equal(recent.planTypeRaw, "prolite");
  assert.equal(recent.stale, true);

  await assert.rejects(
    () => providerAt("2026-07-20T00:00:00.001Z").fetchUsage(),
    hasCode("REQUEST_TIMEOUT")
  );
});

test("Windows system proxy parsing accepts only an enabled loopback HTTP endpoint", () => {
  assert.equal(parseWindowsSystemProxySettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http://127.0.0.1:12334
  `), "http://127.0.0.1:12334");
  assert.equal(parseWindowsSystemProxySettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http=127.0.0.1:1080;https=localhost:12334
  `), "http://localhost:12334");
  assert.equal(parseWindowsSystemProxySettings(`
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ       http://127.0.0.1:12334
  `), null);
  assert.equal(parseWindowsSystemProxySettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http://proxy.example.com:8080
  `), null);
  assert.equal(parseWindowsSystemProxySettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http://user:secret@127.0.0.1:12334
  `), null);
});

test("only the Windows Codex usage request receives the scoped system proxy", async () => {
  const calls: string[] = [];
  const fetchImpl = createCodexUsageFetch({
    platform: "win32",
    resolveProxy: async () => "http://127.0.0.1:12334",
    directFetch: async (input) => {
      calls.push(`direct:${input}`);
      return okResponse(payload());
    },
    scopedProxyFetch: async (proxy, input) => {
      calls.push(`proxy:${proxy}:${input}`);
      return okResponse(payload());
    }
  });
  const signal = new AbortController().signal;

  await fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: { Authorization: `Bearer ${testToken}` },
    signal
  });
  await fetchImpl("https://example.com/not-codex", {
    method: "GET",
    headers: {},
    signal
  });

  assert.deepEqual(calls, [
    "proxy:http://127.0.0.1:12334:https://chatgpt.com/backend-api/wham/usage",
    "direct:https://example.com/not-codex"
  ]);
  assert.equal(calls.join("\n").includes(testToken), false);
});

test("a stale Windows system proxy falls back to the normal OS route", async () => {
  const calls: string[] = [];
  const fetchImpl = createCodexUsageFetch({
    platform: "win32",
    resolveProxy: async () => "http://127.0.0.1:12334",
    directFetch: async (input) => {
      calls.push(`direct:${input}`);
      return okResponse(payload());
    },
    scopedProxyFetch: async () => {
      calls.push("proxy");
      throw new Error("local proxy is not listening");
    }
  });

  const response = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: { Authorization: `Bearer ${testToken}` },
    signal: new AbortController().signal
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [
    "proxy",
    "direct:https://chatgpt.com/backend-api/wham/usage"
  ]);
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

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature-not-returned`;
}
