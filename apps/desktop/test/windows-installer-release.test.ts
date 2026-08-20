import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertExpectedWindowsSignature,
  normalizeCertificateSha1,
  resolveWindowsSigningConfiguration,
  WINDOWS_SIGNING_POLICY
} from "../scripts/windows-authenticode.ts";
import {
  classifyWindowsReleaseArtifact,
  portableRelativePath,
  WINDOWS_RELEASE_POLICY
} from "../scripts/windows-release.ts";

const CERTIFICATE = "0123456789ABCDEF0123456789ABCDEF01234567";

test("Windows release signing configuration fails closed and requires SHA-256 HTTPS timestamping", () => {
  assert.equal(normalizeCertificateSha1("01:23 456789abcdef0123456789abcdef01234567"), CERTIFICATE);
  assert.throws(() => resolveWindowsSigningConfiguration({}), /40 hexadecimal digits/);
  assert.throws(() => resolveWindowsSigningConfiguration({
    TETI_WINDOWS_CERTIFICATE_SHA1: CERTIFICATE,
    TETI_WINDOWS_SIGNTOOL_PATH: "signtool.exe",
    TETI_WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test"
  }), /absolute path/);
  assert.throws(() => resolveWindowsSigningConfiguration({
    TETI_WINDOWS_CERTIFICATE_SHA1: CERTIFICATE,
    TETI_WINDOWS_SIGNTOOL_PATH: "/SDK/signtool.exe",
    TETI_WINDOWS_TIMESTAMP_URL: "http://timestamp.example.test"
  }), /must use HTTPS/);
  assert.equal(WINDOWS_SIGNING_POLICY.digestAlgorithm, "SHA256");
  assert.equal(WINDOWS_SIGNING_POLICY.timestampDigestAlgorithm, "SHA256");
});

test("signed PE verification requires the configured signer and trusted timestamp", () => {
  const valid = {
    status: "Valid",
    statusMessage: "Signature verified.",
    signerSubject: "CN=Teti",
    signerThumbprint: CERTIFICATE,
    timestampSubject: "CN=Timestamp",
    timestampThumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  };
  assert.doesNotThrow(() => assertExpectedWindowsSignature(valid, CERTIFICATE, "setup"));
  assert.throws(() => assertExpectedWindowsSignature({ ...valid, status: "HashMismatch" }, CERTIFICATE, "setup"), /invalid/);
  assert.throws(() => assertExpectedWindowsSignature({ ...valid, signerThumbprint: "B".repeat(40) }, CERTIFICATE, "setup"), /configured Teti certificate/);
  assert.throws(() => assertExpectedWindowsSignature({ ...valid, timestampThumbprint: null }, CERTIFICATE, "setup"), /timestamp/);
});

test("release inventory classifies setup, application, and bundled Runtime without external paths", () => {
  assert.equal(classifyWindowsReleaseArtifact("C:\\repo\\target\\release\\bundle\\nsis\\Teti-setup.exe"), "installer");
  assert.equal(classifyWindowsReleaseArtifact("C:\\repo\\src-tauri\\resources\\runtime\\node.exe"), "runtime");
  assert.equal(classifyWindowsReleaseArtifact("C:\\repo\\target\\release\\teti-desktop.exe"), "application");
  assert.equal(portableRelativePath("/repo", "/repo/apps/desktop/setup.exe"), "apps/desktop/setup.exe");
  assert.throws(() => portableRelativePath("/repo", "/outside/setup.exe"), /outside/);
  assert.equal(WINDOWS_RELEASE_POLICY.installMode, "currentUser");
  assert.deepEqual(WINDOWS_RELEASE_POLICY.installerLanguages, ["English", "SimpChinese"]);
  assert.equal(WINDOWS_RELEASE_POLICY.webview2, "embedded-evergreen-bootstrapper");
});

test("NSIS hooks never delete Profile or WebView state", async () => {
  const hooks = await readFile(new URL("../src-tauri/nsis/installer-hooks.nsh", import.meta.url), "utf8");
  assert.match(hooks, /NSIS_HOOK_PREINSTALL/);
  assert.match(hooks, /NSIS_HOOK_PREUNINSTALL/);
  assert.doesNotMatch(hooks, /\b(?:Delete|RMDir)\b/i);
  assert.doesNotMatch(hooks, /\$(?:APPDATA|LOCALAPPDATA)/i);
});

test("clean-VM script gates install, WebView2, repair, upgrade, state preservation, and uninstall", async () => {
  const source = await readFile(new URL("../scripts/windows-installer-smoke.ps1", import.meta.url), "utf8");
  for (const marker of [
    "RequireMissingWebView2",
    "Get-AuthenticodeSignature",
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "Invoke-RuntimeSmoke",
    "prerelease-upgrade",
    "repair",
    "profilePreserved",
    "languagePreferencePreserved",
    "uninstallPreservedState"
  ]) assert.ok(source.includes(marker), marker);
  assert.match(source, /locale\.json/);
  assert.match(source, /preference\":\"zh-Hans/);
  assert.match(source, /survived application exit/);
});

test("all release version owners stay aligned", async () => {
  const [rootPackage, desktopPackage, tauri, cargo] = await Promise.all([
    readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8")
  ]);
  const expectedVersion = "0.5.1-beta.1";
  assert.equal((JSON.parse(rootPackage) as { version?: string }).version, expectedVersion);
  assert.equal((JSON.parse(desktopPackage) as { version?: string }).version, expectedVersion);
  assert.equal((JSON.parse(tauri) as { version?: string }).version, expectedVersion);
  assert.match(cargo, new RegExp(`^version = "${expectedVersion.replaceAll(".", "\\.")}"$`, "m"));
});
