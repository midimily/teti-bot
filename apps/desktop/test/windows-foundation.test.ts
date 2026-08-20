import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDesktopI18n } from "../src/i18n/index.ts";
import {
  validateDesktopRuntimeDiagnostics,
  validateDesktopPlatformInfo,
  type DesktopPlatformInfo
} from "../src/platform/contract.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import { createDesktopAccountLifecycle } from "../src/provisioning/index.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const desktopRoot = join(repoRoot, "apps", "desktop");
const tauriRoot = join(desktopRoot, "src-tauri");

const WINDOWS_PLATFORM: DesktopPlatformInfo = {
  platform: "windows",
  architecture: "x64",
  shell: "top-center-companion",
  lifecycleRuntime: "bundled",
  supportsDockReopen: false,
  supportsNativeSleepEvents: true,
  supportsRevealInFileManager: true
};

test("Tauri common configuration contains no platform-only bundle ownership", () => {
  const common = readJson(join(tauriRoot, "tauri.conf.json"));
  const app = common.app as Record<string, unknown>;
  const bundle = common.bundle as Record<string, unknown>;

  assert.equal("macOSPrivateApi" in app, false);
  assert.equal("targets" in bundle, false);
  assert.equal("resources" in bundle, false);
  assert.equal("icon" in bundle, false);
  assert.equal("macOS" in bundle, false);
  assert.equal("windows" in bundle, false);
});

test("Windows Tauri overlay owns NSIS, verified Runtime resources, and ICO metadata", () => {
  const windows = readJson(join(tauriRoot, "tauri.windows.conf.json"));
  const app = windows.app as {
    security: { assetProtocol: { enable: boolean; scope: string[] } };
  };
  const bundle = windows.bundle as {
    targets: string[];
    icon: string[];
    resources: Record<string, string>;
    windows: {
      allowDowngrades: boolean;
      digestAlgorithm: string;
      webviewInstallMode: { type: string; silent: boolean };
      nsis: {
        installMode: string;
        languages: string[];
        displayLanguageSelector: boolean;
        installerIcon: string;
        uninstallerIcon: string;
        compression: string;
        startMenuFolder: string;
        installerHooks: string;
      };
    };
  };

  assert.deepEqual(bundle.targets, ["nsis"]);
  assert.deepEqual(bundle.icon, ["icons/icon.ico"]);
  assert.equal(bundle.resources["resources/runtime/node.exe"], "runtime/node.exe");
  assert.equal(
    bundle.resources["resources/runtime/deltachat-rpc-server.exe"],
    "runtime/deltachat-rpc-server.exe"
  );
  assert.equal(bundle.windows.allowDowngrades, false);
  assert.equal(bundle.windows.digestAlgorithm, "sha256");
  assert.equal("signCommand" in bundle.windows, false);
  assert.equal(bundle.windows.webviewInstallMode.type, "embedBootstrapper");
  assert.equal(bundle.windows.webviewInstallMode.silent, true);
  assert.equal(bundle.windows.nsis.installMode, "currentUser");
  assert.deepEqual(bundle.windows.nsis.languages, ["English", "SimpChinese"]);
  assert.equal(bundle.windows.nsis.displayLanguageSelector, false);
  assert.equal(bundle.windows.nsis.compression, "lzma");
  assert.equal(bundle.windows.nsis.startMenuFolder, "Teti");
  assert.equal(existsSync(join(tauriRoot, bundle.windows.nsis.installerIcon)), true);
  assert.equal(existsSync(join(tauriRoot, bundle.windows.nsis.uninstallerIcon)), true);
  assert.equal(existsSync(join(tauriRoot, bundle.windows.nsis.installerHooks)), true);
  assert.equal(app.security.assetProtocol.enable, true);
  assert.deepEqual(app.security.assetProtocol.scope, [
    "$APPLOCALDATA/profile/store-v2/task-attachments/input/**",
    "$APPLOCALDATA/profile/store-v2/task-attachments/artifact/**"
  ]);
});

test("desktop package builds inject an absolute Windows signing command without POSIX env syntax", () => {
  const desktopPackage = readJson(join(desktopRoot, "package.json")) as {
    scripts: Record<string, string>;
  };
  const buildScripts = [
    desktopPackage.scripts["tauri:build"],
    desktopPackage.scripts["tauri:build:app"],
    desktopPackage.scripts["tauri:build:release"],
    desktopPackage.scripts["tauri:build:app:release"],
    desktopPackage.scripts["tauri:build:windows:shell"]
  ];
  assert.ok(buildScripts.every((script) => script.includes("scripts/tauri-build.ts")));
  assert.ok(buildScripts.every((script) => !script.startsWith("TETI_BUILD_TYPE=")));

  const wrapper = readFileSync(join(desktopRoot, "scripts", "tauri-build.ts"), "utf8");
  assert.match(wrapper, /cmd: process\.execPath/);
  assert.match(wrapper, /windows-sign-command\.ts/);
  assert.match(wrapper, /tauriArgs\.push\("--config"/);
  assert.match(wrapper, /tauriArgs\.push\("--no-sign"\)/);
});

test("native platform DTO is bounded and rejects renderer-invented values", () => {
  assert.deepEqual(validateDesktopPlatformInfo(WINDOWS_PLATFORM), WINDOWS_PLATFORM);
  assert.throws(
    () => validateDesktopPlatformInfo({ ...WINDOWS_PLATFORM, platform: "win32" }),
    /invalid native platform information/
  );
  assert.throws(
    () => validateDesktopPlatformInfo({ ...WINDOWS_PLATFORM, profileRoot: "C:\\user-input" }),
    /invalid native platform information/
  );
});

test("Windows Runtime diagnostics expose bounded security state without filesystem paths", () => {
  const value = validateDesktopRuntimeDiagnostics({
    platform: "windows",
    architecture: "x64",
    lifecycleRuntime: "bundled",
    profileSecurity: "protected-acl",
    sidecarState: "running",
    descendantOwnership: "job-object"
  });
  assert.equal(value.profileSecurity, "protected-acl");
  assert.throws(
    () => validateDesktopRuntimeDiagnostics({ ...value, profileRoot: "C:\\Users\\private" }),
    /invalid native Runtime diagnostics/
  );
});

test("Windows native shell selects the bundled lifecycle bridge for First Launch", async () => {
  const tauri = new RecordingTauriInvoker();
  Object.defineProperty(tauri, "runtime", { value: "native" });
  tauri.responses.set("lifecycle_request", {
    version: 1,
    id: "recorded",
    ok: true,
    result: null
  });
  const selection = await createDesktopAccountLifecycle(
    {
      TETI_PROVISIONING_MODE: "real",
      VITE_TETI_MOCK_PROVISIONING_DELAY_MS: "0"
    },
    tauri,
    WINDOWS_PLATFORM
  );

  assert.equal(selection.config.mode, "real");
  assert.equal(tauri.calls.length, 1);
  assert.equal(tauri.calls[0]?.command, "lifecycle_request");
  assert.equal(await selection.lifecycle.loadTetiAccount(), null);
  assert.equal(tauri.calls.length, 2);

  for (const locale of ["zh-Hans", "en"] as const) {
    const i18n = createDesktopI18n(locale);
    assert.ok(i18n.messages.firstLaunch.welcome.title.length > 0);
  }
});

test("Rust shell declares platform paths and the non-Mac companion window", () => {
  const platform = readFileSync(join(tauriRoot, "src", "platform", "mod.rs"), "utf8");
  const window = readFileSync(join(tauriRoot, "src", "window.rs"), "utf8");
  const runtimeBundler = readFileSync(join(desktopRoot, "scripts", "bundle-runtime.ts"), "utf8");

  assert.match(platform, /TETI_DESKTOP_PLATFORM/);
  assert.match(platform, /TETI_PROFILE_DIR/);
  assert.match(platform, /TETI_DESKTOP_LOG_DIR/);
  assert.match(platform, /DesktopPlatform::Macos \| DesktopPlatform::Windows => LifecycleRuntime::Bundled/);
  assert.match(window, /cfg\(not\(target_os = "macos"\)\)/);
  assert.match(window, /position_window_top_center/);
  assert.match(runtimeBundler, /verifyWindowsRuntime/);
  assert.match(runtimeBundler, /deltachat-rpc-server\.exe/);
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
