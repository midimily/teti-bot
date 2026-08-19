import { execFile, spawn } from "node:child_process";
import { win32 } from "node:path";

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const MAX_REGISTRY_OUTPUT_BYTES = 64 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 512 * 1024;
const CODEX_USAGE_HOST = "chatgpt.com";
const REGISTRY_TYPE_PREFIX = "R" + "EG_";

export interface CodexUsageFetchInit {
  method: "GET";
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface CodexUsageFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type CodexUsageFetch = (
  input: string,
  init: CodexUsageFetchInit
) => Promise<CodexUsageFetchResponse>;

type ScopedProxyFetch = (
  proxy: string,
  input: string,
  init: CodexUsageFetchInit
) => Promise<CodexUsageFetchResponse>;

export interface CodexUsageFetchOptions {
  platform?: NodeJS.Platform;
  directFetch?: CodexUsageFetch;
  resolveProxy?: () => Promise<string | null>;
  scopedProxyFetch?: ScopedProxyFetch;
}

/**
 * Tunnel VPNs are already honored by the normal Windows route. Local-proxy
 * VPNs are discovered through the current user's enabled Windows loopback
 * HTTP proxy, without matching a product, process, or fixed port. The proxy is
 * scoped to this Codex usage request; other Runtime traffic is unchanged.
 */
export function createCodexUsageFetch(options: CodexUsageFetchOptions = {}): CodexUsageFetch {
  const platform = options.platform ?? process.platform;
  const directFetch = options.directFetch ?? (fetch as CodexUsageFetch);
  const resolveProxy = options.resolveProxy ?? readWindowsSystemProxy;
  const scopedProxyFetch = options.scopedProxyFetch ?? fetchWithScopedProxyProcess;
  return async (input, init) => {
    if (platform !== "win32" || !isCodexUsageUrl(input)) {
      return await directFetch(input, init);
    }
    const proxy = await resolveProxy().catch(() => null);
    if (!proxy) return await directFetch(input, init);
    try {
      return await scopedProxyFetch(proxy, input, init);
    } catch (error) {
      if (init.signal.aborted) throw error;
      return await directFetch(input, init);
    }
  };
}

export async function readWindowsSystemProxy(
  environment: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
  if (!/^[A-Za-z]:\\[^\u0000-\u001f]+$/.test(systemRoot)) return null;
  const executable = win32.join(systemRoot, "System32", "reg.exe");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["query", INTERNET_SETTINGS_KEY], {
      windowsHide: true,
      timeout: 1_500,
      maxBuffer: MAX_REGISTRY_OUTPUT_BYTES,
      encoding: "utf8",
      env: copyEnvironment(environment, ["SystemRoot", "SYSTEMROOT", "ComSpec", "TEMP", "TMP"])
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return parseWindowsSystemProxySettings(output);
}

export function parseWindowsSystemProxySettings(output: string): string | null {
  if (Buffer.byteLength(output, "utf8") > MAX_REGISTRY_OUTPUT_BYTES) return null;
  const enabled = readRegistryValue(output, "ProxyEnable");
  if (!enabled || Number.parseInt(enabled, 0) !== 1) return null;
  const configured = readRegistryValue(output, "ProxyServer")?.trim();
  if (!configured || configured.length > 512) return null;

  const candidate = configured.includes("=")
    ? selectProtocolProxy(configured)
    : configured;
  if (!candidate) return null;
  return normalizeLoopbackHttpProxy(candidate);
}

function readRegistryValue(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === name && fields[1]?.startsWith(REGISTRY_TYPE_PREFIX) && fields.length >= 3) {
      return fields.slice(2).join(" ");
    }
  }
  return null;
}

function selectProtocolProxy(configured: string): string | null {
  const entries = new Map(configured.split(";").flatMap((entry) => {
    const [protocol, address] = entry.split("=", 2).map((part) => part.trim());
    return protocol && address ? [[protocol.toLowerCase(), address] as const] : [];
  }));
  return entries.get("https") ?? entries.get("http") ?? null;
}

function normalizeLoopbackHttpProxy(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (url.protocol !== "http:"
    || !loopback
    || !url.port
    || url.username
    || url.password
    || (url.pathname && url.pathname !== "/")
    || url.search
    || url.hash) {
    return null;
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const formattedHost = hostname === "::1" ? "[::1]" : hostname;
  return `http://${formattedHost}:${port}`;
}

function isCodexUsageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === CODEX_USAGE_HOST
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

const PROXY_REQUEST_SOURCE = String.raw`
const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > 64 * 1024) process.exit(2);
  chunks.push(chunk);
}
try {
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const response = await fetch(request.input, {
    method: "GET",
    headers: request.headers
  });
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 256 * 1024) process.exit(3);
  process.stdout.write(JSON.stringify({
    kind: "response",
    ok: response.ok,
    status: response.status,
    body
  }));
} catch {
  process.stdout.write(JSON.stringify({ kind: "failure" }));
  process.exitCode = 1;
}
`;

function fetchWithScopedProxyProcess(
  proxy: string,
  input: string,
  init: CodexUsageFetchInit
): Promise<CodexUsageFetchResponse> {
  if (init.signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--use-env-proxy",
      "--input-type=module",
      "--eval",
      PROXY_REQUEST_SOURCE
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...copyEnvironment(process.env, ["SystemRoot", "SYSTEMROOT", "ComSpec", "TEMP", "TMP"]),
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        NO_PROXY: "localhost,127.0.0.1,::1",
        NODE_NO_WARNINGS: "1"
      }
    });
    let output = Buffer.alloc(0);
    let settled = false;
    let outputExceeded = false;

    const cleanup = () => init.signal.removeEventListener("abort", abort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      child.kill();
      fail(createAbortError());
    };

    init.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || outputExceeded) return;
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_PROXY_RESPONSE_BYTES) {
        outputExceeded = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.once("error", () => fail(new Error("CODEX_PROXY_PROCESS_FAILED")));
    child.once("close", () => {
      if (settled) return;
      cleanup();
      if (outputExceeded) {
        fail(new Error("CODEX_PROXY_RESPONSE_TOO_LARGE"));
        return;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(output.toString("utf8"));
      } catch {
        fail(new Error("CODEX_PROXY_RESPONSE_INVALID"));
        return;
      }
      if (!isProxyResponseEnvelope(envelope)) {
        fail(new Error("CODEX_PROXY_REQUEST_FAILED"));
        return;
      }
      settled = true;
      resolve({
        ok: envelope.ok,
        status: envelope.status,
        json: async () => JSON.parse(envelope.body)
      });
    });
    child.stdin.once("error", () => {
      if (!settled && !init.signal.aborted) {
        child.kill();
        fail(new Error("CODEX_PROXY_INPUT_FAILED"));
      }
    });
    child.stdin.end(JSON.stringify({ input, headers: init.headers }), "utf8");
  });
}

function createAbortError(): Error {
  const error = new Error("CODEX_PROXY_REQUEST_ABORTED");
  error.name = "AbortError";
  return error;
}

function isProxyResponseEnvelope(value: unknown): value is {
  kind: "response";
  ok: boolean;
  status: number;
  body: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "response"
    && typeof candidate.ok === "boolean"
    && Number.isSafeInteger(candidate.status)
    && Number(candidate.status) >= 100
    && Number(candidate.status) <= 599
    && typeof candidate.body === "string";
}

function copyEnvironment(
  environment: NodeJS.ProcessEnv,
  names: readonly string[]
): NodeJS.ProcessEnv {
  return Object.fromEntries(names.flatMap((name) =>
    environment[name] === undefined ? [] : [[name, environment[name]!]]
  ));
}
