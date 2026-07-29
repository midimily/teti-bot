import assert from "node:assert/strict";
import test from "node:test";
import { cloneBuiltinAgentDetectors } from "../lifecycle-sidecar/runtime/agents/defaults.ts";
import { AgentObserverSupervisor } from "../lifecycle-sidecar/runtime/agents/supervisor.ts";
import type {
  AgentDetectorCatalog,
  AgentObserverSystem
} from "../lifecycle-sidecar/runtime/agents/types.ts";

test("Passport Agent list stays empty until the first discovery completes", async () => {
  const catalogGate = deferred<AgentDetectorCatalog>();
  const observer = new AgentObserverSupervisor({
    loadCatalog: () => catalogGate.promise,
    system: fakeSystem({
      processNames: ["claude"],
      executables: new Map([["codex", "/opt/teti-test/codex"]])
    })
  });

  const discovery = observer.discover();
  assert.equal(observer.getCurrentSnapshot().state, "discovering");
  assert.deepEqual(observer.getPassportAgents(), []);

  catalogGate.resolve(builtinCatalog());
  const snapshot = await discovery;
  assert.equal(snapshot.state, "ready");
  assert.equal(observer.getPassportAgents().length, 6);
  assert.equal(observer.getPassportAgents().find((agent) => agent.id === "codex")?.installationStatus, "installed");
  assert.equal(observer.getPassportAgents().find((agent) => agent.id === "claude-code")?.runtimeStatus, "running");
});

test("one detector timeout degrades only that Agent and does not block its peers", async () => {
  const observer = new AgentObserverSupervisor({
    loadCatalog: async () => builtinCatalog([
      "codex",
      "claude-code"
    ]),
    system: fakeSystem({
      findExecutable(names) {
        if (names.includes("codex")) return new Promise(() => undefined);
        return Promise.resolve({ canonicalPath: "/opt/teti-test/claude" });
      }
    }),
    detectorTimeoutMs: 10
  });

  const snapshot = await observer.discover();
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.agents.find((agent) => agent.agentId === "codex")?.errors[0]?.code, "AGENT_DETECTOR_TIMEOUT");
  assert.equal(
    snapshot.agents.find((agent) => agent.agentId === "claude-code")?.installation?.state,
    "installed"
  );
});

test("version probe failure and process enumeration failure remain safe and isolated", async () => {
  const observer = new AgentObserverSupervisor({
    loadCatalog: async () => builtinCatalog(["codex", "claude-code"]),
    system: fakeSystem({
      executables: new Map([
        ["codex", "/opt/teti-test/codex"],
        ["claude", "/opt/teti-test/claude"]
      ]),
      async listProcessNames() {
        throw Object.assign(new Error("private process failure"), {
          code: "PROCESS_ENUMERATION_FAILED",
          token: "must-not-leak"
        });
      },
      async runVersionProbe(path) {
        if (path.endsWith("codex")) {
          throw Object.assign(new Error("too much private output"), { code: "VERSION_OUTPUT_LIMIT" });
        }
        return "Claude Code 1.2.3";
      }
    })
  });

  const snapshot = await observer.discover();
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.errors[0]?.code, "PROCESS_ENUMERATION_FAILED");
  assert.equal(snapshot.agents.find((agent) => agent.agentId === "codex")?.errors[0]?.code, "VERSION_OUTPUT_LIMIT");
  assert.equal(
    snapshot.agents.find((agent) => agent.agentId === "claude-code")?.installation?.version,
    "Claude Code 1.2.3"
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /private|token|must-not-leak/i);
});

test("damaged configuration degrades the snapshot without suppressing healthy built-ins", async () => {
  const catalog = builtinCatalog();
  catalog.errors = [{ code: "AGENT_CONFIG_INVALID_JSON", recoverable: true }];
  const observer = new AgentObserverSupervisor({
    loadCatalog: async () => catalog,
    system: fakeSystem({
      executables: new Map([["codex", "/opt/teti-test/codex"]])
    })
  });

  const snapshot = await observer.discover();
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.errors[0]?.code, "AGENT_CONFIG_INVALID_JSON");
  assert.equal(snapshot.agents.length, 6);
  assert.equal(snapshot.agents.find((agent) => agent.agentId === "codex")?.installation?.state, "installed");
});

test("CodeBuddy CN is detected from its verified app bundle and helper process", async () => {
  const observer = new AgentObserverSupervisor({
    loadCatalog: async () => builtinCatalog(["codebuddy"]),
    system: fakeSystem({
      processNames: ["CodeBuddy CN Helper"],
      async inspectAppBundle(paths, bundleIdentifiers, readVersion) {
        if (
          paths.includes("/Applications/CodeBuddy CN.app")
          && bundleIdentifiers.includes("com.tencent.codebuddycn")
          && readVersion
        ) {
          return { present: true, version: "4.10.4" };
        }
        return { present: false };
      }
    })
  });

  const snapshot = await observer.discover();
  const codeBuddy = snapshot.agents.find((agent) => agent.agentId === "codebuddy");
  assert.equal(snapshot.state, "ready");
  assert.equal(codeBuddy?.installation?.state, "installed");
  assert.equal(codeBuddy?.installation?.version, "4.10.4");
  assert.equal(codeBuddy?.runtime?.state, "running");
  assert.equal(codeBuddy?.runtime?.processCount, 1);
  assert.equal(observer.getPassportAgents()[0]?.detectionSource, "application");
});

test("periodic discovery retains the last completed list while a new scan is in progress", async () => {
  let scans = 0;
  const secondGate = deferred<AgentDetectorCatalog>();
  const observer = new AgentObserverSupervisor({
    loadCatalog: () => {
      scans += 1;
      return scans === 1 ? Promise.resolve(builtinCatalog(["codex"])) : secondGate.promise;
    },
    system: fakeSystem({
      executables: new Map([["codex", "/opt/teti-test/codex"]])
    })
  });

  await observer.discover();
  const refresh = observer.discover();
  assert.equal(observer.getCurrentSnapshot().state, "discovering");
  assert.equal(observer.getPassportAgents().length, 1);
  secondGate.resolve(builtinCatalog(["codex"]));
  await refresh;
});

function builtinCatalog(ids?: string[]): AgentDetectorCatalog {
  const definitions = cloneBuiltinAgentDetectors()
    .filter((definition) => !ids || ids.includes(definition.id));
  return {
    schemaVersion: 1,
    discoveryEnabled: true,
    customDetectorsEnabled: true,
    definitions,
    errors: []
  };
}

function fakeSystem(
  overrides: Partial<AgentObserverSystem> & {
    executables?: Map<string, string>;
    processNames?: string[];
  } = {}
): AgentObserverSystem {
  return {
    async findExecutable(names) {
      if (overrides.findExecutable) return overrides.findExecutable(names);
      for (const name of names) {
        const path = overrides.executables?.get(name);
        if (path) return { canonicalPath: path };
      }
      return null;
    },
    async findExecutablePath(paths, expectedNames) {
      return overrides.findExecutablePath?.(paths, expectedNames) ?? null;
    },
    async inspectAppBundle(paths, bundleIdentifiers, readVersion) {
      return overrides.inspectAppBundle?.(paths, bundleIdentifiers, readVersion)
        ?? { present: false };
    },
    async listProcessNames() {
      return overrides.listProcessNames?.() ?? overrides.processNames ?? [];
    },
    async runVersionProbe(path, probe) {
      return overrides.runVersionProbe?.(path, probe) ?? `${path.split("/").pop()} 1.0.0`;
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}
