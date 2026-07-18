import { pathToFileURL } from "node:url";

const CANONICAL_REGISTRY_KEY_PATTERN = /^teti:teti_[a-z0-9]{9}$/;

export function auditRegistryKeyNames(names) {
  const uppercase = [];
  const invalid = [];
  const canonicalGroups = new Map();

  for (const name of names) {
    const folded = name.toLowerCase();
    const group = canonicalGroups.get(folded) ?? [];
    group.push(name);
    canonicalGroups.set(folded, group);

    if (CANONICAL_REGISTRY_KEY_PATTERN.test(name)) continue;
    if (name !== folded && CANONICAL_REGISTRY_KEY_PATTERN.test(folded)) {
      uppercase.push(name);
    } else {
      invalid.push(name);
    }
  }

  const collisions = Array.from(canonicalGroups.entries())
    .filter(([, variants]) => new Set(variants).size > 1)
    .map(([canonicalKey, variants]) => ({ canonicalKey, variants: Array.from(new Set(variants)).sort() }));

  return {
    scanned: names.length,
    canonical: names.length - uppercase.length - invalid.length,
    uppercase: uppercase.sort(),
    invalid: invalid.sort(),
    collisions
  };
}

export async function listRegistryKeyNames({ accountId, namespaceId, apiToken, fetchImpl = fetch }) {
  const names = [];
  let cursor;
  do {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
      `/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/keys`
    );
    url.searchParams.set("limit", "1000");
    url.searchParams.set("prefix", "teti:");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiToken}` }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success || !Array.isArray(body.result)) {
      throw new Error(`Cloudflare KV key audit failed with HTTP ${response.status}.`);
    }
    for (const entry of body.result) {
      if (typeof entry?.name === "string") names.push(entry.name);
    }
    cursor = typeof body.result_info?.cursor === "string" && body.result_info.cursor
      ? body.result_info.cursor
      : undefined;
  } while (cursor);
  return names;
}

async function main() {
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const namespaceId = requiredEnv("TETI_KV_NAMESPACE_ID");
  const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
  const names = await listRegistryKeyNames({ accountId, namespaceId, apiToken });
  const report = auditRegistryKeyNames(names);
  console.log(JSON.stringify(report, null, 2));
  if (report.uppercase.length || report.invalid.length || report.collisions.length) {
    process.exitCode = 1;
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the read-only KV public ID audit.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
