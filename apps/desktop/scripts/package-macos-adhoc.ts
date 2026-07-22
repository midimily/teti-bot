import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectChatmailRpcRuntime } from "../../../integrations/chatmail/runtime-diagnostics.ts";

const execFileAsync = promisify(execFile);
const EXPECTED_PRODUCT = "Teti";
const EXPECTED_BUNDLE_ID = "bot.teti.app";
const EXPECTED_ARCH = "arm64";
const EXPECTED_MINIMUM_MACOS = "15.0";
const EXPECTED_NATIVE_PATHS = [
  "Contents/MacOS/teti-desktop",
  "Contents/Resources/runtime/node",
  "Contents/Resources/runtime/deltachat-rpc-server"
] as const;

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const tauriRoot = join(desktopRoot, "src-tauri");
const appPath = join(tauriRoot, "target", "release", "bundle", "macos", "Teti.app");
const releaseRoot = join(desktopRoot, "release");

interface NativeArtifact {
  path: string;
  fileType: string;
  architectures: string[];
  minimumMacOS: string;
  executable: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

await main().catch((error) => {
  console.error(`macOS ad-hoc Alpha packaging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  assertHost();
  const metadata = await readAndValidateMetadata();
  const gitCommit = (await capture("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
  const gitStatus = (await capture("git", ["status", "--porcelain"], { cwd: repoRoot })).stdout.trim();
  console.log(`Packaging commit ${gitCommit}${gitStatus ? " with local changes" : " from a clean worktree"}.`);
  if (gitStatus) console.warn("Warning: the release manifest will record gitDirty=true.");

  await mkdir(releaseRoot, { recursive: true });
  await cleanOldAlphaOutputs();
  await rm(appPath, { recursive: true, force: true });

  const tauriBinary = join(desktopRoot, "node_modules", ".bin", "tauri");
  await access(tauriBinary, constants.X_OK);
  await runStreaming(tauriBinary, ["build", "--bundles", "app"], desktopRoot);

  await assertAppMetadata(appPath);
  const nativeArtifacts = await inspectNativeArtifacts(appPath);
  assertExpectedNativeArtifacts(nativeArtifacts);
  assertArm64Only(nativeArtifacts);
  assertMinimumVersions(nativeArtifacts);

  const bundledNode = join(appPath, "Contents", "Resources", "runtime", "node");
  const bundledRpc = join(appPath, "Contents", "Resources", "runtime", "deltachat-rpc-server");
  await signAdHoc(bundledNode);
  await signAdHoc(bundledRpc);
  await signAdHoc(appPath);
  const signature = await verifyAdHocSignature(appPath);

  const runtimeSmoke = await runRuntimeSmoke(appPath);
  await verifyCodeSignature(appPath);

  const artifactBase = `${EXPECTED_PRODUCT}-${metadata.version}-arm64-macos15-adhoc-alpha`;
  const dmgFileName = `${artifactBase}.dmg`;
  const readmeFileName = `${artifactBase}-README.txt`;
  const manifestFileName = `${artifactBase}.release.json`;
  const shaFileName = `${dmgFileName}.sha256`;
  const dmgPath = join(releaseRoot, dmgFileName);
  const readmePath = join(releaseRoot, readmeFileName);
  const manifestPath = join(releaseRoot, manifestFileName);
  const shaPath = join(releaseRoot, shaFileName);

  await writeFile(readmePath, alphaReadme(dmgFileName), "utf8");
  await createAndValidateDmg({ appPath, dmgPath, readmePath, nativeArtifacts });

  const sha256 = await sha256File(dmgPath);
  await writeFile(shaPath, `${sha256}  ${dmgFileName}\n`, "utf8");
  const dmgStat = await stat(dmgPath);
  const nodeVersion = (await capture(bundledNode, ["--version"])).stdout.trim();
  const deltaChatRpcVersionResult = await capture(bundledRpc, ["--version"]);
  const deltaChatRpcVersion = `${deltaChatRpcVersionResult.stdout}${deltaChatRpcVersionResult.stderr}`.trim();
  const xcode = (await capture("xcodebuild", ["-version"])).stdout.trim().replace(/\n+/g, " / ");
  const sdkVersion = (await capture("xcrun", ["--sdk", "macosx", "--show-sdk-version"])).stdout.trim();

  const manifest = {
    productName: EXPECTED_PRODUCT,
    version: metadata.version,
    bundleIdentifier: EXPECTED_BUNDLE_ID,
    releaseChannel: "alpha",
    distribution: "adhoc",
    architecture: EXPECTED_ARCH,
    minimumMacOS: EXPECTED_MINIMUM_MACOS,
    notarized: false,
    developerIdSigned: false,
    gatekeeperTrusted: false,
    gitCommit,
    gitDirty: Boolean(gitStatus),
    buildTime: new Date().toISOString(),
    nodeVersion,
    deltaChatRpcVersion,
    xcodeVersion: xcode,
    sdkVersion,
    fileName: dmgFileName,
    fileSize: dmgStat.size,
    sha256,
    signature,
    nativeArtifacts,
    runtimeSmoke
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    distribution: "ad-hoc controlled Alpha (not notarized)",
    appPath,
    dmgPath,
    shaPath,
    manifestPath,
    readmePath,
    sha256
  }, null, 2));
}

function assertHost(): void {
  if (process.platform !== "darwin") throw new Error("This package can only be built on macOS.");
  if (process.arch !== "arm64") throw new Error("This Alpha package must be built on an arm64 Mac.");
}

async function readAndValidateMetadata(): Promise<{ version: string }> {
  const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version?: string };
  const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as { version?: string };
  const tauriConfig = JSON.parse(await readFile(join(tauriRoot, "tauri.conf.json"), "utf8")) as {
    productName?: string;
    version?: string;
    identifier?: string;
    bundle?: { targets?: string[]; macOS?: { minimumSystemVersion?: string } };
  };
  const cargoToml = await readFile(join(tauriRoot, "Cargo.toml"), "utf8");
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const versions = [rootPackage.version, desktopPackage.version, tauriConfig.version, cargoVersion];

  assert(tauriConfig.productName === EXPECTED_PRODUCT, `productName must be ${EXPECTED_PRODUCT}.`);
  assert(tauriConfig.identifier === EXPECTED_BUNDLE_ID, `Bundle Identifier must be ${EXPECTED_BUNDLE_ID}.`);
  assert(tauriConfig.bundle?.macOS?.minimumSystemVersion === EXPECTED_MINIMUM_MACOS, "Minimum macOS must remain 15.0.");
  assert(tauriConfig.bundle?.targets?.includes("app") && tauriConfig.bundle.targets.includes("dmg"), "Tauri targets must include app and dmg.");
  assert(versions.every((version) => version === versions[0]), `Version mismatch: ${versions.join(", ")}`);
  assert(typeof versions[0] === "string" && /^\d+\.\d+\.\d+$/.test(versions[0]), "Version must be semver.");
  return { version: versions[0] };
}

async function cleanOldAlphaOutputs(): Promise<void> {
  for (const entry of await readdir(releaseRoot, { withFileTypes: true })) {
    if (entry.name.startsWith("Teti-") && entry.name.includes("-adhoc-alpha")) {
      await rm(join(releaseRoot, entry.name), { recursive: entry.isDirectory(), force: true });
    }
  }
}

async function assertAppMetadata(path: string): Promise<void> {
  const plist = join(path, "Contents", "Info.plist");
  const bundleId = (await capture("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])).stdout.trim();
  const minimum = (await capture("/usr/libexec/PlistBuddy", ["-c", "Print :LSMinimumSystemVersion", plist])).stdout.trim();
  assert(bundleId === EXPECTED_BUNDLE_ID, `Built CFBundleIdentifier is ${bundleId}, expected ${EXPECTED_BUNDLE_ID}.`);
  assert(minimum === EXPECTED_MINIMUM_MACOS, `Built LSMinimumSystemVersion is ${minimum}, expected 15.0.`);
}

async function inspectNativeArtifacts(root: string): Promise<NativeArtifact[]> {
  const artifacts: NativeArtifact[] = [];
  for (const filePath of await listRegularFiles(root)) {
    const rawFileType = (await capture("file", [filePath])).stdout.trim();
    if (!rawFileType.includes("Mach-O")) continue;
    const fileType = rawFileType.includes(": ") ? rawFileType.slice(rawFileType.indexOf(": ") + 2) : rawFileType;
    const archOutput = (await capture("lipo", ["-archs", filePath])).stdout.trim();
    const minimumMacOS = parseMinimumMacOS((await capture("otool", ["-l", filePath])).stdout);
    artifacts.push({
      path: relative(root, filePath),
      fileType,
      architectures: archOutput.split(/\s+/).filter(Boolean),
      minimumMacOS,
      executable: await isExecutable(filePath)
    });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function assertExpectedNativeArtifacts(artifacts: NativeArtifact[]): void {
  const actual = artifacts.map((artifact) => artifact.path).sort();
  const expected = [...EXPECTED_NATIVE_PATHS].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Unexpected Mach-O inventory: ${actual.join(", ")}`);
  assert(artifacts.every((artifact) => artifact.executable), "Every embedded Mach-O must retain its executable bit.");
}

function assertArm64Only(artifacts: NativeArtifact[]): void {
  for (const artifact of artifacts) {
    assert(artifact.architectures.length === 1 && artifact.architectures[0] === EXPECTED_ARCH, `${artifact.path} is not arm64-only.`);
  }
}

function assertMinimumVersions(artifacts: NativeArtifact[]): void {
  const main = artifacts.find((artifact) => artifact.path === "Contents/MacOS/teti-desktop");
  assert(main?.minimumMacOS === EXPECTED_MINIMUM_MACOS, "Teti main executable deployment target must remain 15.0.");
}

async function signAdHoc(path: string): Promise<void> {
  await capture("codesign", ["--force", "--sign", "-", "--timestamp=none", path]);
}

async function verifyAdHocSignature(path: string): Promise<{ signature: "adhoc"; teamIdentifier: "not set"; hardenedRuntime: false; notarized: false }> {
  await verifyCodeSignature(path);
  const details = await captureAllowingStderr("codesign", ["-dv", "--verbose=4", path]);
  const combined = `${details.stdout}\n${details.stderr}`;
  assert(combined.includes("Signature=adhoc"), "Expected Signature=adhoc.");
  assert(combined.includes("TeamIdentifier=not set"), "Expected TeamIdentifier=not set.");
  assert(!/flags=.*\bruntime\b/.test(combined), "Hardened Runtime was not requested for this ad-hoc Alpha.");
  return { signature: "adhoc", teamIdentifier: "not set", hardenedRuntime: false, notarized: false };
}

async function verifyCodeSignature(path: string): Promise<void> {
  await captureAllowingStderr("codesign", ["--verify", "--deep", "--strict", "--verbose=4", path]);
}

async function runRuntimeSmoke(path: string): Promise<Record<string, unknown>> {
  const node = join(path, "Contents", "Resources", "runtime", "node");
  const rpc = join(path, "Contents", "Resources", "runtime", "deltachat-rpc-server");
  const sidecar = join(path, "Contents", "Resources", "lifecycle-sidecar", "main.mjs");
  const smokeRoot = await mkdtemp(join(tmpdir(), "teti-adhoc-runtime-smoke-"));
  try {
    const nodeVersion = (await capture(node, ["--version"], { cwd: smokeRoot })).stdout.trim();
    const diagnostics = await inspectChatmailRpcRuntime({
      rpcServerPath: rpc,
      accountsPath: join(smokeRoot, "rpc-accounts"),
      workingDirectory: smokeRoot,
      env: { ...process.env, HOME: smokeRoot }
    });
    assert(diagnostics.jsonRpcHealth && diagnostics.cleanShutdown && diagnostics.architecture === "arm64", `DeltaChat RPC smoke failed: ${diagnostics.errors.join("; ")}`);

    const sidecarSource = await readFile(sidecar, "utf8");
    assert(!sidecarSource.includes(repoRoot), "Bundled lifecycle sidecar contains a repository absolute path dependency.");
    const lifecycle = await runLifecycleHealth(node, sidecar, rpc, smokeRoot);
    assert(lifecycle, "Bundled lifecycle sidecar health check failed.");
    assert(!(await pathExists(join(smokeRoot, "account", "account.json"))), "Runtime smoke unexpectedly created a Teti account.");

    return {
      nodeExecutable: true,
      nodeVersion,
      deltaChatRpcExecutable: diagnostics.executable,
      deltaChatRpcVersion: diagnostics.version,
      deltaChatRpcJsonRpcHealth: diagnostics.jsonRpcHealth,
      deltaChatRpcCleanShutdown: diagnostics.cleanShutdown,
      lifecycleSidecarHealth: lifecycle,
      usedBundledNode: true,
      usedBundledRpc: true,
      repositoryPathIndependent: true,
      realAccountCreated: false
    };
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function runLifecycleHealth(node: string, sidecar: string, rpc: string, smokeRoot: string): Promise<boolean> {
  const child = spawn(node, ["--experimental-strip-types", sidecar], {
    cwd: smokeRoot,
    env: {
      ...process.env,
      HOME: smokeRoot,
      TETI_PROFILE_DIR: smokeRoot,
      TETI_CODEX_HOME: join(smokeRoot, "empty-codex"),
      TETI_DELTACHAT_RPC_PATH: rpc
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const responsePromise = waitForJsonLine(child, "adhoc-smoke-health", 10_000);
  child.stdin.write(`${JSON.stringify({ version: 1, id: "adhoc-smoke-health", method: "lifecycle.health", params: {} })}\n`);
  const response = await responsePromise;
  child.stdin.end();
  await waitForChildExit(child, 8_000);
  return response.ok === true && (response.result as { status?: unknown } | undefined)?.status === "ok";
}

async function createAndValidateDmg(input: {
  appPath: string;
  dmgPath: string;
  readmePath: string;
  nativeArtifacts: NativeArtifact[];
}): Promise<void> {
  const workRoot = await mkdtemp(join(tmpdir(), "teti-adhoc-dmg-"));
  const stagingRoot = join(workRoot, "staging");
  const mountPoint = join(workRoot, "mount");
  let mounted = false;
  try {
    await mkdir(stagingRoot, { recursive: true });
    await cp(input.appPath, join(stagingRoot, "Teti.app"), { recursive: true, preserveTimestamps: true });
    await cp(input.readmePath, join(stagingRoot, basename(input.readmePath)));
    await symlink("/Applications", join(stagingRoot, "Applications"));
    await capture("hdiutil", [
      "create",
      "-ov",
      "-format", "UDZO",
      "-fs", "HFS+",
      "-volname", "Teti Ad-hoc Alpha",
      "-srcfolder", stagingRoot,
      input.dmgPath
    ]);
    await capture("hdiutil", ["verify", input.dmgPath]);

    await mkdir(mountPoint, { recursive: true });
    await capture("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, input.dmgPath]);
    mounted = true;
    const mountedApp = join(mountPoint, "Teti.app");
    const applicationsLink = join(mountPoint, "Applications");
    assert((await lstat(mountedApp)).isDirectory(), "Mounted DMG does not contain Teti.app.");
    assert((await lstat(applicationsLink)).isSymbolicLink(), "Mounted DMG does not contain an Applications symlink.");
    assert((await readlink(applicationsLink)) === "/Applications", "Applications symlink target is not /Applications.");
    await assertAppMetadata(mountedApp);
    await verifyCodeSignature(mountedApp);
    const mountedArtifacts = await inspectNativeArtifacts(mountedApp);
    assertExpectedNativeArtifacts(mountedArtifacts);
    assertArm64Only(mountedArtifacts);
    assert(mountedArtifacts.every((artifact) => artifact.executable), "DMG changed a Runtime executable bit.");
    assert(JSON.stringify(mountedArtifacts.map(({ path, architectures, minimumMacOS, executable }) => ({ path, architectures, minimumMacOS, executable }))) ===
      JSON.stringify(input.nativeArtifacts.map(({ path, architectures, minimumMacOS, executable }) => ({ path, architectures, minimumMacOS, executable }))),
    "DMG native inventory differs from the signed source App.");
  } finally {
    if (mounted) await capture("hdiutil", ["detach", mountPoint]);
    await rm(workRoot, { recursive: true, force: true });
  }
}

function alphaReadme(dmgFileName: string): string {
  return `Teti macOS Ad-hoc Alpha
This build is for controlled testing only.

Requirements:
- Apple Silicon Mac
- macOS 15.0 or later

This build:
- is ad-hoc signed
- is not signed with Apple Developer ID
- is not notarized by Apple
- is not trusted by Gatekeeper as a formal distribution
- may be blocked by macOS Gatekeeper on first launch

Install:
1. Open ${dmgFileName}.
2. Drag Teti into Applications.
3. Open Teti from Applications.
4. If macOS blocks it, open System Settings -> Privacy & Security.
5. Find the blocked Teti notice and choose "Open Anyway".
6. Confirm opening Teti.

Do not:
- disable Gatekeeper
- run xattr commands to bypass security checks
- share this build publicly

中文说明
这是仅用于小范围受控测试的 Teti macOS Alpha 安装包。
要求：Apple Silicon Mac、macOS 15.0 或更高版本。
本安装包仅使用 ad-hoc 签名，没有 Apple Developer ID，也没有经过 Apple 公证。
首次启动可能被 Gatekeeper 拦截。请前往“系统设置 -> 隐私与安全性”，找到 Teti 提示并点击“仍要打开”。
请勿关闭 Gatekeeper、请勿使用 xattr 绕过系统安全检查、请勿公开传播本安装包。
`;
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const candidate = join(path, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  await visit(root);
  return files;
}

function parseMinimumMacOS(output: string): string {
  const match = output.match(/cmd LC_BUILD_VERSION[\s\S]*?\n\s*minos\s+([0-9.]+)/);
  if (!match) throw new Error("Mach-O does not contain LC_BUILD_VERSION minos.");
  return match[1];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function waitForJsonLine(child: ChildProcessWithoutNullStreams, expectedId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Lifecycle sidecar health timed out. stderr=${stderr.trim()}`)), timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      while (stdout.includes("\n")) {
        const index = stdout.indexOf("\n");
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.id === expectedId) {
            clearTimeout(timeout);
            resolvePromise(value);
          }
        } catch {
          clearTimeout(timeout);
          reject(new Error(`Lifecycle sidecar emitted invalid JSON: ${line}`));
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) return;
      clearTimeout(timeout);
      reject(new Error(`Lifecycle sidecar exited early code=${code} signal=${signal}. stderr=${stderr.trim()}`));
    });
  });
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Lifecycle sidecar did not stop within its bounded shutdown window."));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Lifecycle sidecar shutdown exited with code ${code}.`));
    });
  });
}

async function runStreaming(command: string, args: string[], cwd: string): Promise<void> {
  console.log(`$ ${command} ${args.join(" ")}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${basename(command)} exited with code ${code}.`)));
  });
}

async function capture(command: string, args: string[], options: { cwd?: string } = {}): Promise<CommandResult> {
  const result = await execFileAsync(command, args, { cwd: options.cwd, maxBuffer: 32 * 1024 * 1024 });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function captureAllowingStderr(command: string, args: string[]): Promise<CommandResult> {
  return capture(command, args);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
