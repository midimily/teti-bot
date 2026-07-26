import assert from "node:assert/strict";
import test from "node:test";
import {
  FileAgentDetectorConfiguration,
  loadAgentDetectorCatalog,
  TETI_AGENT_DISCOVERY_DISABLED
} from "../lifecycle-sidecar/runtime/agents/config.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = "/tmp/teti-agent-detectors.override.json";

test("missing or malformed override config keeps the five safe built-in detectors", async () => {
  const missing = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    async readText() {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
  });
  assert.deepEqual(
    missing.definitions.map((definition) => definition.id),
    ["codex", "claude-code", "gemini-cli", "cursor", "codebuddy"]
  );
  assert.deepEqual(missing.errors, []);

  const malformed = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    async readText() { return "{"; }
  });
  assert.deepEqual(
    malformed.definitions.map((definition) => definition.id),
    ["codex", "claude-code", "gemini-cli", "cursor", "codebuddy"]
  );
  assert.equal(malformed.errors[0]?.code, "AGENT_CONFIG_INVALID_JSON");
});

test("override can disable built-ins and the custom-detector kill switch blocks custom entries", async () => {
  const result = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    async readText() {
      return JSON.stringify({
        schemaVersion: 1,
        discoveryEnabled: true,
        customDetectorsEnabled: false,
        agents: [
          { id: "cursor", enabled: false },
          customAppDefinition()
        ]
      });
    }
  });

  assert.deepEqual(
    result.definitions.map((definition) => definition.id),
    ["codex", "claude-code", "gemini-cli", "codebuddy"]
  );
  assert.equal(result.customDetectorsEnabled, false);
  assert.deepEqual(result.errors, []);
});

test("valid custom detectors are declarative and cannot add commands or unsafe app paths", async () => {
  const valid = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    async readText() {
      return JSON.stringify({
        schemaVersion: 1,
        customDetectorsEnabled: true,
        agents: [customAppDefinition()]
      });
    }
  });
  const custom = valid.definitions.find((definition) => definition.id === "user.local-agent");
  assert.equal(custom?.displayName, "Local Agent");
  assert.equal(custom?.versionProbe, undefined);
  assert.equal(custom?.privacy.networkAllowed, false);

  const unsafe = customAppDefinition() as Record<string, unknown>;
  unsafe.installDetectors = [{
    type: "app_bundle",
    paths: ["/tmp/Private.app"],
    bundleIdentifiers: [],
    readVersion: true
  }];
  unsafe.versionProbe = { type: "fixed_args", args: ["--version"] };
  const rejected = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    async readText() {
      return JSON.stringify({
        schemaVersion: 1,
        customDetectorsEnabled: true,
        agents: [unsafe]
      });
    }
  });
  assert.equal(rejected.definitions.some((definition) => definition.id === "user.local-agent"), false);
  assert.equal(rejected.errors[0]?.code, "AGENT_CONFIG_ENTRY_INVALID");
});

test("global discovery kill switch returns no detector definitions", async () => {
  const result = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    async readText() {
      return JSON.stringify({
        schemaVersion: 1,
        discoveryEnabled: false
      });
    }
  });
  assert.equal(result.discoveryEnabled, false);
  assert.deepEqual(result.definitions, []);

  const environmentDisabled = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    env: { [TETI_AGENT_DISCOVERY_DISABLED]: "1" },
    async readText() {
      throw new Error("the kill switch must short-circuit a broken config reader");
    }
  });
  assert.equal(environmentDisabled.discoveryEnabled, false);
  assert.equal(environmentDisabled.customDetectorsEnabled, false);
  assert.deepEqual(environmentDisabled.definitions, []);
});

test("built-in path overrides stay declarative and retain fixed Agent identity", async () => {
  const result = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    async readText() {
      return JSON.stringify({
        schemaVersion: 1,
        agents: [
          { id: "codex", enabled: true, pathOverride: "/Applications/ChatGPT.app/Contents/Resources/codex" },
          { id: "cursor", enabled: true, pathOverride: "~/Applications/Cursor.app" }
        ]
      });
    }
  });
  const codex = result.definitions.find((definition) => definition.id === "codex");
  const cursor = result.definitions.find((definition) => definition.id === "cursor");
  assert.deepEqual(codex?.installDetectors[0], {
    type: "executable_path",
    paths: ["/Applications/ChatGPT.app/Contents/Resources/codex"],
    expectedNames: ["codex"]
  });
  assert.equal(cursor?.installDetectors[0]?.type, "app_bundle");
  assert.deepEqual(
    cursor?.installDetectors[0]?.type === "app_bundle"
      ? cursor.installDetectors[0].bundleIdentifiers
      : [],
    ["com.todesktop.230313mzl4w4u92"]
  );

  const rejected = await loadAgentDetectorCatalog({
    path: CONFIG_PATH,
    async readText() {
      return JSON.stringify({
        schemaVersion: 1,
        agents: [{ id: "codex", enabled: true, pathOverride: "/tmp/not-codex" }]
      });
    }
  });
  assert.equal(rejected.errors[0]?.code, "AGENT_CONFIG_BUILTIN_OVERRIDE_INVALID");
  assert.equal(rejected.definitions.find((definition) => definition.id === "codex")?.installDetectors[0]?.type, "executable");
});

test("file-backed path override is private, atomic, removable, and refuses damaged config", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-agent-config-"));
  const path = join(root, "agent-detectors.override.json");
  const store = new FileAgentDetectorConfiguration(path);
  try {
    await store.setPathOverride("gemini-cli", "/opt/homebrew/bin/gemini");
    assert.deepEqual(await store.getPathOverrides(), {
      "gemini-cli": "/opt/homebrew/bin/gemini"
    });
    assert.doesNotMatch(await readFile(path, "utf8"), /prompt|token|credential/i);
    await store.setPathOverride("gemini-cli", null);
    assert.deepEqual(await store.getPathOverrides(), {});

    await writeFile(path, "{", "utf8");
    await assert.rejects(
      () => store.setPathOverride("codex", "/opt/homebrew/bin/codex"),
      (error: unknown) => errorCode(error) === "AGENT_CONFIG_WRITE_BLOCKED"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function customAppDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "user.local-agent",
    provider: "local",
    displayName: "Local Agent",
    enabled: true,
    surfaces: ["desktop"],
    installDetectors: [{
      type: "app_bundle",
      paths: ["/Applications/Local Agent.app"],
      bundleIdentifiers: [],
      readVersion: true
    }],
    processDetectors: [{
      type: "exact_name",
      names: ["Local Agent"]
    }],
    capabilities: {
      installation: true,
      version: true,
      runtime: true,
      activity: false,
      entitlement: false,
      quota: false
    },
    privacy: {
      collectPaths: false,
      collectCommands: false,
      collectContent: false,
      networkAllowed: false,
      shareByDefault: false
    },
    source: "user",
    revision: 1
  };
}
