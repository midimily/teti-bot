import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toFirstLaunchViewModel } from "../src/first-launch/view-model.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const desktopRoot = join(repoRoot, "apps", "desktop");
const tauriConfigPath = join(desktopRoot, "src-tauri", "tauri.conf.json");

test("macOS bundle metadata uses the Teti product identity", () => {
  const config = readJson<{
    productName: string;
    identifier: string;
    version: string;
    app: { windows: unknown[] };
    bundle: {
      active: boolean;
      targets: string[];
      category: string;
      icon: string[];
      macOS: { minimumSystemVersion: string };
    };
  }>(tauriConfigPath);

  assert.equal(config.productName, "Teti");
  assert.equal(config.identifier, "im.midimily.teti.desktop");
  assert.match(config.version, /^\d+\.\d+\.\d+$/);
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.targets, ["app"]);
  assert.equal(config.bundle.category, "Productivity");
  assert.deepEqual(config.app.windows, []);
});

test("desktop icon configuration references generated Teti assets", () => {
  const config = readJson<{ bundle: { icon: string[] } }>(tauriConfigPath);
  assert.deepEqual(config.bundle.icon, [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.png"
  ]);

  for (const icon of config.bundle.icon) {
    assert.equal(icon.toLowerCase().includes("tauri"), false);
    assert.equal(existsSync(join(desktopRoot, "src-tauri", icon)), true, `${icon} should exist`);
  }
  assert.equal(existsSync(join(desktopRoot, "assets", "icon-source.png")), true);
});

test("minimum macOS deployment target is explicit and consistent", () => {
  const config = readJson<{ bundle: { macOS: { minimumSystemVersion: string } } }>(tauriConfigPath);
  const cargoConfig = readFileSync(join(desktopRoot, "src-tauri", ".cargo", "config.toml"), "utf8");

  assert.equal(config.bundle.macOS.minimumSystemVersion, "15.0");
  assert.match(cargoConfig, /MACOSX_DEPLOYMENT_TARGET\s*=\s*"15\.0"/);
});

test("build diagnostics script reports compatibility-critical fields", () => {
  const script = readFileSync(join(desktopRoot, "scripts", "build-diagnostics.ts"), "utf8");

  for (const field of [
    "host",
    "xcode",
    "sdkVersion",
    "deploymentTarget",
    "architecture",
    "tauriVersion",
    "rustcVersion",
    "rpcVersion"
  ]) {
    assert.match(script, new RegExp(field));
  }
});

test("first-launch user copy avoids transport and credential internals", () => {
  const snapshots = [
    { state: "checking_existing_account", nameInput: "", submitting: false },
    { state: "welcome", nameInput: "", submitting: false },
    { state: "naming", nameInput: "", submitting: false },
    { state: "creating_identity", nameInput: "Milo", submitting: true, phase: "provisioning_chatmail" },
    { state: "creating_identity", nameInput: "Milo", submitting: true, phase: "persisting_account" },
    { state: "registering_discovery", nameInput: "Milo", submitting: true, phase: "registering_identity" },
    { state: "fatal_error", nameInput: "", submitting: false }
  ] as const;
  const forbidden = /\b(IMAP|SMTP|Delta Chat RPC|RPC|DCACCOUNT|credentials|relay|cryptographic|keys|Chatmail)\b/i;

  for (const snapshot of snapshots) {
    const viewModel = toFirstLaunchViewModel(snapshot);
    const visibleText = [
      viewModel.title,
      viewModel.message,
      viewModel.primaryAction,
      viewModel.input?.placeholder,
      viewModel.input?.error,
      viewModel.progress?.label
    ].filter(Boolean).join(" ");

    assert.doesNotMatch(visibleText, forbidden);
  }
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
