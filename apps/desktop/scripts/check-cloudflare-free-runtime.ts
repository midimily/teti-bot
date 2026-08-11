import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const SOURCE_ROOTS = [
  "apps/desktop/src",
  "apps/desktop/lifecycle-sidecar",
  "apps/desktop/src-tauri/src",
  "apps/desktop/scripts",
  "core",
  "integrations",
  "services"
] as const;
const LEGACY_PATHS = [
  "services/discovery-worker",
  "services/discovery/registry-client.ts",
  "services/network/legacy-worker-adapter.ts"
] as const;
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".rs"]);

const SOURCE_RULES = [
  { name: "legacy Worker host", pattern: new RegExp("workers" + "\\.dev", "i") },
  { name: "legacy provider REST host", pattern: new RegExp("api\\." + "cloudflare\\.com", "i") },
  { name: "legacy Registry URL", pattern: new RegExp("TETI_" + "REGISTRY_URL") },
  { name: "legacy Registry error", pattern: new RegExp("\\b" + "REG_[A-Z0-9_]+\\b") },
  { name: "provider package", pattern: new RegExp("@" + "cloudflare/") },
  { name: "provider API package", pattern: new RegExp("cloudflare" + "-api", "i") },
  { name: "provider KV package", pattern: new RegExp("cloudflare" + "-kv", "i") }
] as const;
const FORBIDDEN_DEPENDENCY = new RegExp("cloudflare|workers-kv", "i");

export interface CloudflareFreeAuditResult {
  filesScanned: number;
  violations: string[];
}

export async function auditCloudflareFreeRuntime(
  repoRoot = DEFAULT_REPO_ROOT
): Promise<CloudflareFreeAuditResult> {
  const violations: string[] = [];
  const files = (
    await Promise.all(SOURCE_ROOTS.map((root) => collectSourceFiles(resolve(repoRoot, root))))
  ).flat();

  for (const file of files) {
    if (file === SCRIPT_PATH || file.endsWith(".test.ts")) continue;
    const content = await readFile(file, "utf8");
    for (const rule of SOURCE_RULES) {
      if (rule.pattern.test(content)) {
        violations.push(`${relative(repoRoot, file)}: ${rule.name}`);
      }
    }
  }

  for (const legacyPath of LEGACY_PATHS) {
    if (await pathExists(resolve(repoRoot, legacyPath))) {
      violations.push(`${legacyPath}: legacy runtime path still exists`);
    }
  }

  for (const manifestPath of ["package.json", "apps/desktop/package.json"]) {
    const manifest = JSON.parse(
      await readFile(resolve(repoRoot, manifestPath), "utf8")
    ) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    for (const dependency of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {})
    ]) {
      if (FORBIDDEN_DEPENDENCY.test(dependency)) {
        violations.push(`${manifestPath}: forbidden production dependency ${dependency}`);
      }
    }
  }

  const networkHttpOwner = await readFile(resolve(repoRoot, "services/network/client.ts"), "utf8");
  if (!networkHttpOwner.includes("globalThis.fetch") || !networkHttpOwner.includes("/v1/bootstrap")) {
    violations.push("services/network/client.ts: Network HTTP ownership invariant is missing");
  }
  for (const file of files) {
    if (file === SCRIPT_PATH || file.endsWith(".test.ts")) continue;
    const content = await readFile(file, "utf8");
    const relativePath = relative(repoRoot, file);
    if (!relativePath.startsWith("services/network/")
      && /["'`]\/v1\/(?:bootstrap|public\/nodes|public\/stats|identity|relay-bindings|relays|profile\/self|client-instances|presence|relationships)/.test(content)) {
      violations.push(`${relativePath}: formal Network route escaped services/network`);
    }
    if (content.includes("new HttpTetiNetworkClient")
      && relativePath !== "apps/desktop/lifecycle-sidecar/main.ts") {
      violations.push(`${relativePath}: NetworkClient construction escaped Runtime composition`);
    }
  }

  return { filesScanned: files.length, violations };
}

async function collectSourceFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (["node_modules", "target", "dist", ".git"].includes(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(path));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (SOURCE_EXTENSIONS.has(extension)) files.push(path);
  }
  return files;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  const result = await auditCloudflareFreeRuntime();
  if (result.violations.length > 0) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ...result, status: "cloudflare-free" }, null, 2));
  }
}
