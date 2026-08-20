import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { toFirstLaunchViewModel } from "../src/first-launch/view-model.ts";
import { createDesktopI18n } from "../src/i18n/index.ts";

const zhHans = createDesktopI18n("zh-Hans");

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const desktopRoot = join(repoRoot, "apps", "desktop");
const tauriConfigPath = join(desktopRoot, "src-tauri", "tauri.conf.json");
const tauriMacosConfigPath = join(desktopRoot, "src-tauri", "tauri.macos.conf.json");

test("macOS bundle metadata uses the Teti product identity", () => {
  const common = readJson<{
    productName: string;
    identifier: string;
    version: string;
    app: { windows: unknown[] };
    bundle: {
      active: boolean;
      category: string;
    };
  }>(tauriConfigPath);
  const macos = readJson<{
    bundle: {
      targets: string[];
      icon: string[];
      resources: Record<string, string>;
      macOS: { minimumSystemVersion: string };
    };
  }>(tauriMacosConfigPath);

  assert.equal(common.productName, "Teti");
  assert.equal(common.identifier, "bot.teti.app");
  assert.match(common.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(common.bundle.active, true);
  assert.deepEqual(macos.bundle.targets, ["app", "dmg"]);
  assert.equal(common.bundle.category, "Productivity");
  assert.equal(
    macos.bundle.resources["resources/lifecycle-sidecar/codex-image-runner.mjs"],
    "lifecycle-sidecar/codex-image-runner.mjs"
  );
  assert.deepEqual(common.app.windows, []);
});

test("desktop icon configuration references generated Teti assets", () => {
  const config = readJson<{ bundle: { icon: string[] } }>(tauriMacosConfigPath);
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
  const config = readJson<{ bundle: { macOS: { minimumSystemVersion: string } } }>(tauriMacosConfigPath);
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
    { state: "synchronizing_network_identity", nameInput: "Milo", submitting: true, phase: "registering_identity" },
    { state: "fatal_error", nameInput: "", submitting: false }
  ] as const;
  const forbidden = /\b(IMAP|SMTP|Delta Chat RPC|RPC|DCACCOUNT|credentials|relay|cryptographic|keys|Chatmail)\b/i;

  for (const snapshot of snapshots) {
    const viewModel = toFirstLaunchViewModel(snapshot, zhHans);
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

test("desktop shell exposes AI Passport and explicit Passport sharing consent", () => {
  const app = readFileSync(join(desktopRoot, "src", "app.ts"), "utf8");
  const passportView = readFileSync(join(desktopRoot, "src", "passport", "view.ts"), "utf8");
  const passportViewModel = readFileSync(join(desktopRoot, "src", "passport", "view-model.ts"), "utf8");
  const styles = readFileSync(join(desktopRoot, "src", "styles.css"), "utf8");

  assert.match(passportViewModel, /title: i18n\.messages\.passport\.title/);
  assert.match(passportViewModel, /toggleLabel: settingsMessages\.sharing/);
  assert.doesNotMatch(passportViewModel, /i18n\?\.messages|settingsMessages\?\./);
  assert.doesNotMatch(passportView, /本周额度剩余/);
  assert.doesNotMatch(app, /界面设置|减少动画|运行状态/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /data-reduced-motion/);
  assert.match(app, /target\.closest\("\.teti-header-panel"\)/);
  assert.match(app, /target\.closest\("\.teti-header-icon\[aria-expanded\]"\)/);
  assert.match(app, /options\.tauri\.onDockActivate/);
  assert.match(app, /createHeaderPanelAnchor\(statusButton, statusPanel\)/);
  assert.match(app, /createHeaderPanelAnchor\(sharingButton, sharingPanel\)/);
  assert.match(styles, /\.teti-header-panel\s*\{[\s\S]*top:\s*calc\(100% \+ 8px\);[\s\S]*right:\s*50%;/);
  assert.match(app, /connections\.open\("task-back-to-island"\)/);
  assert.doesNotMatch(passportView, /toggle\.disabled/);
  assert.doesNotMatch(app, /iconButton\(X, "收起"/);
  assert.match(styles, /\.teti-header\s*\{[\s\S]*right:\s*14px/);
  assert.match(styles, /\.teti-toolbar-asset-icon\s*\{[\s\S]*object-fit:\s*contain/);
  assert.match(styles, /\.teti-toolbar-asset-icon\s*\{[\s\S]*filter:\s*saturate\(0\.78\)/);
  assert.match(styles, /\.teti-task-header-button > svg\s*\{[\s\S]*width:\s*22px;[\s\S]*height:\s*22px/);
  assert.match(styles, /\.teti-task-header-button > svg\s*\{[\s\S]*color:\s*#70dafc;[\s\S]*filter:\s*saturate\(0\.78\);[\s\S]*opacity:\s*0\.82/);
  assert.match(styles, /\.teti-ai-status-panel,[\s\S]*rgba\(255, 255, 255, 0\.38\)/);
  assert.match(styles, /\.teti-sharing-panel[\s\S]*backdrop-filter:\s*blur\(28px\)/);
  assert.match(passportView, /className = "teti-local-logout"/);
  assert.doesNotMatch(passportView, /defaultView\?\.confirm|window\.confirm/);
  assert.match(passportView, /controller\?\.requestLocalProfileLogout\(\)/);
  assert.match(passportView, /controller\?\.confirmLocalProfileLogout\(\)/);
  assert.match(passportView, /className = "teti-local-logout-confirmation"/);
  assert.match(styles, /\.teti-local-logout\s*\{/);
  assert.equal(existsSync(join(desktopRoot, "assets", "codex-status.png")), true);
  assert.equal(existsSync(join(desktopRoot, "assets", "ai-tools-btn.png")), true);
  assert.equal(existsSync(join(desktopRoot, "assets", "settings.png")), true);
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
