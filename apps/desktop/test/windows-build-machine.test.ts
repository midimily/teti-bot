import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  WINDOWS_BUILD_MACHINE_POLICY,
  WINDOWS_BUILD_MACHINE_POLICY_PATH
} from "../scripts/windows-build-machine-policy.ts";
import { WINDOWS_RUNTIME_POLICY } from "../scripts/windows-runtime.ts";

const testRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testRoot, "..", "..", "..");

test("Windows build-machine policy fixes the complete native toolchain", async () => {
  const policy = WINDOWS_BUILD_MACHINE_POLICY;
  assert.equal(policy.policyId, "teti-windows-x64-build-machine-v1");
  assert.equal(policy.node.version, "22.22.3");
  assert.equal(policy.node.npmVersion, "10.9.8");
  assert.equal(policy.rustup.version, "1.29.0");
  assert.equal(policy.rust.toolchain, "1.92.0-x86_64-pc-windows-msvc");
  assert.equal(policy.cargo.registryUrl, "sparse+https://rsproxy.cn/index/");
  assert.equal(policy.visualStudio.productVersion, "17.14.39");
  assert.equal(policy.visualStudio.installationVersion, "17.14.37614.0");
  assert.equal(policy.visualStudio.msvcToolsetPrefix, "14.44.");
  assert.equal(policy.windowsSdk.version, "10.0.26100.0");
  assert.equal(policy.nasm.extractedDirectoryName, "nasm-2.16.03");
  assert.equal(policy.deltaChat.version, "2.54.0-dev");
  assert.equal(policy.deltaChat.revision, "823b0741df82e3ec0f61285d52bf91ae19b1963e");
  assert.equal(policy.deltaChat.cargoLockSha256.length, 64);

  const hashes = [
    policy.node.archiveSha256,
    policy.node.runtimeSha256,
    policy.cargo.configSha256,
    policy.rustup.sha256,
    policy.visualStudio.bootstrapperSha256,
    policy.perl.archiveSha256,
    policy.nasm.archiveSha256,
    policy.deltaChat.cargoLockSha256
  ];
  assert.ok(hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)));
  assert.ok(policy.visualStudio.components.includes(
    "Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64"
  ));
  assert.ok(policy.visualStudio.components.includes(
    "Microsoft.VisualStudio.Component.Windows11SDK.26100"
  ));

  const vsconfig = JSON.parse(await readFile(
    join(repoRoot, "toolchains", "teti-windows-build-tools.vsconfig"),
    "utf8"
  )) as { components: string[] };
  assert.deepEqual(vsconfig.components, policy.visualStudio.components);
  assert.equal(WINDOWS_BUILD_MACHINE_POLICY_PATH, join(
    repoRoot,
    "toolchains",
    "windows-x64-build-machine.json"
  ));

  const cargoConfig = await readFile(
    join(repoRoot, "toolchains", "teti-windows-cargo-config.toml"),
    "utf8"
  );
  assert.match(cargoConfig, /replace-with = "rsproxy-sparse"/);
  assert.match(cargoConfig, /sparse\+https:\/\/rsproxy\.cn\/index\//);
});

test("Windows Runtime consumes build-machine Node and DeltaChat pins", () => {
  assert.equal(WINDOWS_RUNTIME_POLICY.rustTarget, WINDOWS_BUILD_MACHINE_POLICY.rust.target);
  assert.deepEqual(WINDOWS_RUNTIME_POLICY.node, {
    version: WINDOWS_BUILD_MACHINE_POLICY.node.version,
    fileName: WINDOWS_BUILD_MACHINE_POLICY.node.runtimeFileName,
    url: WINDOWS_BUILD_MACHINE_POLICY.node.runtimeUrl,
    sha256: WINDOWS_BUILD_MACHINE_POLICY.node.runtimeSha256
  });
  assert.deepEqual(WINDOWS_RUNTIME_POLICY.deltaChat, {
    revision: WINDOWS_BUILD_MACHINE_POLICY.deltaChat.revision,
    version: WINDOWS_BUILD_MACHINE_POLICY.deltaChat.version,
    fileName: WINDOWS_BUILD_MACHINE_POLICY.deltaChat.fileName
  });
});

test("Windows bootstrap verifies downloads and RPC uses a locked source graph", async () => {
  const bootstrap = await readFile(
    join(repoRoot, "apps", "desktop", "scripts", "windows-build-machine.ps1"),
    "utf8"
  );
  const rpc = await readFile(
    join(repoRoot, "apps", "desktop", "scripts", "rpc.ts"),
    "utf8"
  );
  const windowsRuntime = await readFile(
    join(repoRoot, "apps", "desktop", "scripts", "windows-runtime.ts"),
    "utf8"
  );
  assert.match(bootstrap, /Get-FileHash[\s\S]*SHA256/);
  assert.match(bootstrap, /Visual Studio Build Tools did not install the exact required instance/);
  assert.match(bootstrap, /expectedCmakePrefix/);
  assert.match(bootstrap, /perlVersionLine/);
  assert.match(bootstrap, /-Action Hydrate|"Hydrate"/);
  assert.doesNotMatch(bootstrap, /\b(?:winget|choco)\b/i);
  assert.match(rpc, /"--locked"/);
  assert.match(rpc, /DeltaChat Cargo\.lock does not match/);
  assert.match(rpc, /replaceAll\("\\r\\n", "\\n"\)/);
  assert.match(rpc, /SOURCE_DATE_EPOCH/);
  assert.match(rpc, /core\.autocrlf/);
  assert.match(rpc, /core\.eol/);
  assert.match(rpc, /"checkout-index", "--all", "--force"/);
  assert.match(rpc, /"clean", "-ffdqx"/);
  assert.match(rpc, /must be the managed build-machine checkout/);
  assert.match(windowsRuntime, /copyFileWithWindowsRetry/);
  assert.match(rpc, /runWithRetries/);
  assert.match(rpc, /pinnedCommitAvailable/);
  assert.match(rpc, /http\.version=HTTP\/1\.1/);
  assert.match(rpc, /"--depth=1"/);
});

test("Windows 11 certification hydrates the fixed machine before dependency install", async () => {
  const workflow = await readFile(
    join(repoRoot, ".github", "workflows", "windows-11-x64-certification.yml"),
    "utf8"
  );
  assert.match(workflow, /node-version: 22\.22\.3/);
  assert.match(workflow, /windows-build-machine\.ps1[\s\S]*-Action Hydrate/);
  assert.ok(workflow.indexOf("-Action Hydrate") < workflow.indexOf("npm ci --prefix apps/desktop"));
  assert.match(
    workflow,
    /--ignored real_windows_profile_acl_round_trips_as_protected/,
    "the exact Windows 11 lane must run the real Profile ACL integration test"
  );
  assert.equal(
    workflow.match(/enter-windows-build-machine\.ps1/g)?.length,
    9,
    "every Node/Rust build step must enter the pinned local environment"
  );
});
