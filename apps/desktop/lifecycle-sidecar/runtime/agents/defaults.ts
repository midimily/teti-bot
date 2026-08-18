import type { AgentDetectorDefinition } from "./types.ts";
import type { LifecycleDesktopPlatform } from "../../desktop-platform.ts";

const SAFE_PRIVACY = {
  collectPaths: false,
  collectCommands: false,
  collectContent: false,
  networkAllowed: false,
  shareByDefault: false
} as const;

const LEVEL_1_2_CAPABILITIES = {
  installation: true,
  version: true,
  runtime: true,
  activity: false,
  entitlement: false,
  quota: false
} as const;

export const BUILTIN_AGENT_DETECTORS: readonly AgentDetectorDefinition[] = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    id: "codex",
    provider: "openai",
    displayName: "Codex",
    enabled: true,
    surfaces: ["cli"],
    installDetectors: [
      { type: "executable", names: ["codex"] },
      {
        type: "executable_path",
        paths: [
          "/Applications/ChatGPT.app/Contents/Resources/codex",
          "~/Applications/ChatGPT.app/Contents/Resources/codex",
          "~/.local/bin/codex",
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex"
        ],
        expectedNames: ["codex"]
      }
    ],
    processDetectors: [{ type: "exact_name", names: ["codex"] }],
    versionProbe: {
      type: "fixed_args",
      args: ["--version"],
      timeoutMs: 1_500,
      maxOutputBytes: 32 * 1024
    },
    capabilities: LEVEL_1_2_CAPABILITIES,
    privacy: SAFE_PRIVACY,
    source: "builtin",
    revision: 2
  } satisfies AgentDetectorDefinition),
  Object.freeze({
    schemaVersion: 1,
    id: "osaurus",
    provider: "osaurus",
    displayName: "Osaurus",
    enabled: true,
    surfaces: ["desktop", "local_service"],
    installDetectors: [
      { type: "executable", names: ["osaurus"] },
      {
        type: "app_bundle",
        paths: ["/Applications/Osaurus.app", "~/Applications/Osaurus.app"],
        bundleIdentifiers: ["com.dinoki.osaurus"],
        readVersion: true
      }
    ],
    processDetectors: [{ type: "exact_name", names: ["osaurus"] }],
    versionProbe: {
      type: "fixed_args",
      args: ["--version"],
      timeoutMs: 1_500,
      maxOutputBytes: 32 * 1024
    },
    capabilities: LEVEL_1_2_CAPABILITIES,
    privacy: SAFE_PRIVACY,
    source: "builtin",
    revision: 1
  } satisfies AgentDetectorDefinition),
  Object.freeze({
    schemaVersion: 1,
    id: "claude-code",
    provider: "anthropic",
    displayName: "Claude Code",
    enabled: true,
    surfaces: ["cli"],
    installDetectors: [{ type: "executable", names: ["claude"] }],
    processDetectors: [{ type: "exact_name", names: ["claude"] }],
    versionProbe: {
      type: "fixed_args",
      args: ["--version"],
      timeoutMs: 1_500,
      maxOutputBytes: 32 * 1024
    },
    capabilities: LEVEL_1_2_CAPABILITIES,
    privacy: SAFE_PRIVACY,
    source: "builtin",
    revision: 1
  } satisfies AgentDetectorDefinition),
  Object.freeze({
    schemaVersion: 1,
    id: "gemini-cli",
    provider: "google",
    displayName: "Gemini CLI",
    enabled: true,
    surfaces: ["cli"],
    installDetectors: [{ type: "executable", names: ["gemini"] }],
    processDetectors: [{ type: "exact_name", names: ["gemini"] }],
    versionProbe: {
      type: "fixed_args",
      args: ["--version"],
      timeoutMs: 1_500,
      maxOutputBytes: 32 * 1024
    },
    capabilities: LEVEL_1_2_CAPABILITIES,
    privacy: SAFE_PRIVACY,
    source: "builtin",
    revision: 1
  } satisfies AgentDetectorDefinition),
  Object.freeze({
    schemaVersion: 1,
    id: "cursor",
    provider: "cursor",
    displayName: "Cursor",
    enabled: true,
    surfaces: ["desktop", "cli"],
    installDetectors: [
      { type: "executable", names: ["cursor"] },
      {
        type: "app_bundle",
        paths: ["/Applications/Cursor.app", "~/Applications/Cursor.app"],
        bundleIdentifiers: ["com.todesktop.230313mzl4w4u92"],
        readVersion: true
      }
    ],
    processDetectors: [{ type: "exact_name", names: ["Cursor", "cursor"] }],
    versionProbe: {
      type: "fixed_args",
      args: ["--version"],
      timeoutMs: 1_500,
      maxOutputBytes: 32 * 1024
    },
    capabilities: LEVEL_1_2_CAPABILITIES,
    privacy: SAFE_PRIVACY,
    source: "builtin",
    revision: 1
  } satisfies AgentDetectorDefinition),
  Object.freeze({
    schemaVersion: 1,
    id: "codebuddy",
    provider: "tencent",
    displayName: "CodeBuddy",
    enabled: true,
    surfaces: ["desktop", "cli"],
    installDetectors: [
      { type: "executable", names: ["codebuddy"] },
      {
        type: "app_bundle",
        paths: ["/Applications/CodeBuddy.app", "~/Applications/CodeBuddy.app"],
        bundleIdentifiers: [],
        readVersion: true
      },
      {
        type: "app_bundle",
        paths: ["/Applications/CodeBuddy CN.app", "~/Applications/CodeBuddy CN.app"],
        bundleIdentifiers: ["com.tencent.codebuddycn"],
        readVersion: true
      }
    ],
    processDetectors: [{
      type: "exact_name",
      names: ["CodeBuddy", "codebuddy", "CodeBuddy CN Helper"]
    }],
    versionProbe: {
      type: "fixed_args",
      args: ["--version"],
      timeoutMs: 1_500,
      maxOutputBytes: 32 * 1024
    },
    capabilities: LEVEL_1_2_CAPABILITIES,
    privacy: SAFE_PRIVACY,
    source: "builtin",
    revision: 2
  } satisfies AgentDetectorDefinition)
]);

export function cloneBuiltinAgentDetectors(
  platform: LifecycleDesktopPlatform = "macos"
): AgentDetectorDefinition[] {
  const definitions = structuredClone([...BUILTIN_AGENT_DETECTORS]);
  if (platform === "macos") return definitions;
  return definitions
    .filter((definition) => definition.id !== "osaurus")
    .map((definition) => ({
      ...definition,
      installDetectors: [
        ...(definition.id === "codex"
          ? [{
              type: "executable_path" as const,
              paths: [
                "%LOCALAPPDATA%\\Programs\\ChatGPT\\resources\\codex.exe",
                "%LOCALAPPDATA%\\Programs\\OpenAI\\ChatGPT\\resources\\codex.exe",
                "%USERPROFILE%\\.local\\bin\\codex.exe"
              ],
              expectedNames: ["codex", "codex.exe"]
            }]
          : []),
        ...definition.installDetectors.filter((detector) => detector.type !== "app_bundle")
      ],
      processDetectors: definition.processDetectors.map((detector) => ({
        ...detector,
        names: [...new Set(detector.names.map((name) => name.replace(/\.exe$/i, "")))]
      }))
    }));
}
