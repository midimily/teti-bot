import type { AgentDetectorDefinition } from "./types.ts";

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

export function cloneBuiltinAgentDetectors(): AgentDetectorDefinition[] {
  return structuredClone([...BUILTIN_AGENT_DETECTORS]);
}
