import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPortableExecutable, verifyWindowsRuntime, WINDOWS_RUNTIME_POLICY } from "./windows-runtime.ts";
import {
  assertExpectedWindowsSignature,
  readWindowsAuthenticodeSignature,
  resolveWindowsSigningConfiguration,
  sha256WindowsArtifact,
  type WindowsAuthenticodeSignature
} from "./windows-authenticode.ts";

export const WINDOWS_RELEASE_POLICY = Object.freeze({
  schemaVersion: 1 as const,
  target: "x86_64-pc-windows-msvc",
  installer: "nsis",
  installMode: "currentUser",
  installerLanguages: Object.freeze(["English", "SimpChinese"]),
  webview2: "embedded-evergreen-bootstrapper",
  profileRelativePath: "profile",
  localePreferenceRelativePath: "profile/preferences/locale.json"
});

export interface WindowsReleaseArtifact {
  role: "installer" | "application" | "runtime";
  path: string;
  size: number;
  sha256: string;
  authenticode: WindowsAuthenticodeSignature;
}

export interface WindowsReleaseManifest {
  schemaVersion: 1;
  product: "Teti";
  version: string;
  generatedAt: string;
  target: string;
  installer: {
    type: "nsis";
    installMode: "currentUser";
    languages: readonly string[];
    webview2: string;
  };
  stateCompatibility: {
    identifier: "bot.teti.app";
    profileRelativePath: string;
    localePreferenceRelativePath: string;
  };
  runtimeSource: {
    nodeVersion: string;
    nodeSha256: string;
    deltaChatVersion: string;
    deltaChatRevision: string;
    deltaChatSha256: string;
    allowlistedDlls: string[];
  };
  artifacts: WindowsReleaseArtifact[];
}

export async function createWindowsReleaseManifest(
  desktopRoot: string,
  repoRoot: string,
  generatedAt: string,
  signatureReader: (path: string) => Promise<WindowsAuthenticodeSignature> = readWindowsAuthenticodeSignature
): Promise<WindowsReleaseManifest> {
  const version = await readDesktopVersion(desktopRoot);
  const timestamp = new Date(generatedAt);
  if (!Number.isFinite(timestamp.valueOf())) throw new Error("Windows release timestamp is invalid.");
  const signing = resolveWindowsSigningConfiguration();
  const runtime = await verifyWindowsRuntime(repoRoot);
  if (!runtime.ok || !runtime.nodeSha256 || !runtime.rpcSha256) {
    throw new Error(`Pinned Windows Runtime is invalid:\n${runtime.errors.join("\n")}`);
  }
  const paths = await collectWindowsReleasePePaths(desktopRoot);
  const artifacts: WindowsReleaseArtifact[] = [];
  for (const path of paths) {
    await assertPortableExecutable(path, "x86_64", "Windows release artifact");
    const authenticode = await signatureReader(path);
    assertExpectedWindowsSignature(authenticode, signing.certificateSha1, path);
    const metadata = await stat(path);
    artifacts.push({
      role: classifyWindowsReleaseArtifact(path),
      path: portableRelativePath(repoRoot, path),
      size: metadata.size,
      sha256: await sha256WindowsArtifact(path),
      authenticode
    });
  }
  return {
    schemaVersion: WINDOWS_RELEASE_POLICY.schemaVersion,
    product: "Teti",
    version,
    generatedAt: timestamp.toISOString(),
    target: WINDOWS_RELEASE_POLICY.target,
    installer: {
      type: "nsis",
      installMode: WINDOWS_RELEASE_POLICY.installMode,
      languages: WINDOWS_RELEASE_POLICY.installerLanguages,
      webview2: WINDOWS_RELEASE_POLICY.webview2
    },
    stateCompatibility: {
      identifier: "bot.teti.app",
      profileRelativePath: WINDOWS_RELEASE_POLICY.profileRelativePath,
      localePreferenceRelativePath: WINDOWS_RELEASE_POLICY.localePreferenceRelativePath
    },
    runtimeSource: {
      nodeVersion: WINDOWS_RUNTIME_POLICY.node.version,
      nodeSha256: runtime.nodeSha256,
      deltaChatVersion: WINDOWS_RUNTIME_POLICY.deltaChat.version,
      deltaChatRevision: WINDOWS_RUNTIME_POLICY.deltaChat.revision,
      deltaChatSha256: runtime.rpcSha256,
      allowlistedDlls: [...WINDOWS_RUNTIME_POLICY.allowedDlls]
    },
    artifacts
  };
}

export async function writeWindowsReleaseManifest(
  desktopRoot: string,
  repoRoot: string,
  generatedAt: string
): Promise<{ manifestPath: string; checksumsPath: string; manifest: WindowsReleaseManifest }> {
  const manifest = await createWindowsReleaseManifest(desktopRoot, repoRoot, generatedAt);
  const output = join(repoRoot, "dist", "windows");
  await mkdir(output, { recursive: true });
  const base = `teti-${manifest.version}-windows-x64`;
  const manifestPath = join(output, `${base}-manifest.json`);
  const checksumsPath = join(output, `${base}-SHA256SUMS.txt`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const checksums = manifest.artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.path}`)
    .join("\n");
  await writeFile(checksumsPath, `${checksums}\n`, "utf8");
  return { manifestPath, checksumsPath, manifest };
}

export async function collectWindowsReleasePePaths(desktopRoot: string): Promise<string[]> {
  const tauriRoot = join(desktopRoot, "src-tauri");
  const app = join(tauriRoot, "target", "release", "teti-desktop.exe");
  const runtimeRoot = join(tauriRoot, "resources", "runtime");
  const installerRoot = join(tauriRoot, "target", "release", "bundle", "nsis");
  const runtime = (await listFiles(runtimeRoot))
    .filter((path) => /\.(?:exe|dll)$/i.test(path));
  const installers = (await listFiles(installerRoot))
    .filter((path) => /(?:setup|installer).*\.exe$/i.test(path));
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one NSIS setup executable; found ${installers.length}.`);
  }
  const paths = [app, ...runtime, installers[0]];
  for (const path of paths) {
    const metadata = await stat(path).catch(() => undefined);
    if (!metadata?.isFile()) throw new Error(`Required Windows release artifact is missing: ${path}`);
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

export function classifyWindowsReleaseArtifact(path: string): WindowsReleaseArtifact["role"] {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/bundle/nsis/")) return "installer";
  if (normalized.includes("/resources/runtime/")) return "runtime";
  return "application";
}

export function portableRelativePath(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path));
  if (!value || value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error("Windows release artifact is outside the repository.");
  }
  return value.split(sep).join("/");
}

async function readDesktopVersion(desktopRoot: string): Promise<string> {
  const value = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(value.version)) {
    throw new Error("Windows installer releases require a beta semantic version.");
  }
  return value.version;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const output: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

export const WINDOWS_RELEASE_DESKTOP_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
