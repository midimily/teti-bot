export const TETI_NETWORK_BASE_URL_ENV = "TETI_NETWORK_BASE_URL";
export const DEFAULT_TETI_NETWORK_BASE_URL = "https://network.teti.bot";
export const DEVELOPMENT_TETI_NETWORK_BASE_URL = "http://127.0.0.1:8788";

export type TetiNetworkEnvironment = "production" | "local_development";

export function resolveTetiNetworkBaseUrl(
  env: Record<string, string | undefined> = readProcessEnvironment()
): string {
  return normalizeTetiNetworkBaseUrl(
    env[TETI_NETWORK_BASE_URL_ENV] ?? DEFAULT_TETI_NETWORK_BASE_URL
  );
}

function normalizeTetiNetworkBaseUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TETI_NETWORK_BASE_URL must be a valid absolute URL.");
  }

  const localHttp = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("TETI_NETWORK_BASE_URL must use HTTPS outside local development.");
  }
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || !["", "/"].includes(url.pathname)
  ) {
    throw new Error("TETI_NETWORK_BASE_URL must contain only the Network origin.");
  }

  return url.origin;
}

function readProcessEnvironment(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}
