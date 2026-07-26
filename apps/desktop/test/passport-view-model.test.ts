import assert from "node:assert/strict";
import test from "node:test";
import { emptyPassportSnapshot } from "../src/passport/controller.ts";
import {
  formatLocalTetiIdentity,
  formatResetAt,
  toAgentViewModel,
  toPassportViewModel
} from "../src/passport/view-model.ts";

test("Passport reset time uses the compact month/day and 24-hour format", () => {
  assert.equal(formatResetAt("2026-07-25T14:26:00"), "7/25 14:26 重置");
  assert.equal(formatResetAt(null), "重置时间暂不可用");
  assert.equal(formatResetAt("not-a-date"), "重置时间暂不可用");
});

test("Passport settings show the local Teti name and nine-character ID", () => {
  assert.equal(formatLocalTetiIdentity({
    tetiId: "teti_abc123xyz",
    address: "abc123xyz@mail.seep.im",
    displayName: "Max0717"
  }), "Max0717（abc123xyz）");
  assert.equal(formatLocalTetiIdentity(null), "暂不可用");

  const passport = emptyPassportSnapshot();
  passport.identity = {
    tetiId: "teti_abc123xyz",
    address: "abc123xyz@mail.seep.im",
    displayName: "Max0717"
  };
  const viewModel = toPassportViewModel({ passport, sharingBusy: false, openPanel: "sharing" });
  assert.equal(viewModel.settings.identityLabel, "Max0717（abc123xyz）");
});

test("Passport settings distinguish Registry network recovery from missing registration", () => {
  const passport = emptyPassportSnapshot();
  passport.registry = {
    state: "unreachable",
    checkedAt: "2026-07-23T10:00:00.000Z",
    errorCode: "REG_DNS",
    retryable: true
  };

  let viewModel = toPassportViewModel({ passport, sharingBusy: false, openPanel: "sharing" });
  assert.equal(viewModel.settings.registryLabel, "待同步 [REG-DNS]");
  assert.equal(viewModel.settings.registryTone, "pending");

  passport.registry = {
    state: "not_registered",
    checkedAt: "2026-07-23T10:01:00.000Z",
    retryable: true
  };
  viewModel = toPassportViewModel({ passport, sharingBusy: false, openPanel: "sharing" });
  assert.equal(viewModel.settings.registryLabel, "待同步 [REG-NF]");
});

test("unknown, disabled, and stale remote Passport states use truthful product copy", () => {
  const passport = emptyPassportSnapshot();
  passport.connections = ["unknown", "disabled", "stale"].map((state, index) => ({
    requestId: String(index),
    connectionState: "Confirmed",
    direction: "incoming",
    identity: { tetiId: `teti_${index}`, address: `${index}@mail.seep.im` },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    lastSeen: null,
    passport: { state: state as "unknown" | "disabled" | "stale", resources: [], agents: [] }
  }));
  const viewModel = toPassportViewModel({ passport, sharingBusy: false, openPanel: null });
  assert.deepEqual(viewModel.connections.map((item) => item.passport.note), [
    "暂无 AI Passport",
    "对方未分享 AI Passport",
    "AI Passport 已过期"
  ]);
});

test("local Agent management stays hidden until discovery completes while Callable Agents enter Passport", () => {
  const passport = emptyPassportSnapshot();
  let viewModel = toPassportViewModel({ passport, sharingBusy: false, openPanel: "passport" });
  assert.deepEqual(viewModel.aiPanel.agents, []);
  assert.equal(viewModel.settings.agentManagement.readyToDisplay, false);

  passport.localPassport.agents = [{
    id: "codex",
    name: "Codex",
    provider: "OpenAI",
    capabilityIds: ["code-analysis"],
    inputModes: ["text"],
    outputModes: ["text"],
    availability: "available",
    observedAt: "2026-07-25T00:00:00.000Z"
  }];
  passport.localPassport.capabilities = [{
    id: "code-analysis",
    name: "Code analysis",
    category: "coding",
    description: "Analyze code through a locally qualified AI Agent.",
    availability: "available",
    observedAt: "2026-07-25T00:00:00.000Z"
  }];
  viewModel = toPassportViewModel({ passport, sharingBusy: false, openPanel: "passport" });
  assert.equal(viewModel.aiPanel.agents[0]?.statusLabel, "可调用");
  assert.equal(viewModel.aiPanel.capabilities[0]?.id, "code-analysis");

  viewModel = toPassportViewModel({
    passport,
    sharingBusy: false,
    agentBusy: false,
    openPanel: "sharing",
    agentManagement: {
      schemaVersion: 1,
      revision: 1,
      state: "ready",
      generatedAt: "2026-07-25T00:00:00.000Z",
      completedAt: "2026-07-25T00:00:00.000Z",
      pathOverrides: {},
      errors: [],
      agents: [{
        schemaVersion: 1,
        observationId: "codex:1",
        agentId: "codex",
        provider: "openai",
        displayName: "Codex",
        surfaces: ["cli"],
        supportedLevels: [1, 2],
        installation: { state: "installed", version: "codex-cli 1.2.3", evidence: [] },
        runtime: { state: "running", processCount: 1, evidence: [] },
        observedAt: "2026-07-25T00:00:00.000Z",
        errors: []
      }]
    }
  });
  assert.equal(viewModel.settings.agentManagement.readyToDisplay, true);
  assert.equal(viewModel.settings.agentManagement.agents[0]?.statusLabel, "运行中");
});

test("Agent presentation distinguishes installed, absent, and unknown states", () => {
  const base = {
    id: "agent",
    name: "Agent",
    type: "cli" as const,
    observedAt: "2026-07-25T00:00:00.000Z"
  };
  const installed = toAgentViewModel({
    ...base,
    provider: "openai",
    installationStatus: "installed",
    runtimeStatus: "not_running"
  });
  assert.equal(installed.providerName, "OpenAI");
  assert.equal(installed.statusLabel, "已安装");
  assert.equal(toAgentViewModel({
    ...base,
    installationStatus: "not_installed",
    runtimeStatus: "not_running"
  }).statusLabel, "未发现");
  assert.equal(toAgentViewModel({
    ...base,
    installationStatus: "unknown",
    runtimeStatus: "unknown"
  }).statusLabel, "未确认");
});

test("Agent management orders running, installed, unknown, then absent without reshuffling peers", () => {
  const passport = emptyPassportSnapshot();
  const observedAt = "2026-07-25T00:00:00.000Z";
  const observation = (
    agentId: string,
    displayName: string,
    installation: "installed" | "not_installed" | "unknown",
    runtime: "running" | "not_running" | "unknown"
  ) => ({
    schemaVersion: 1 as const,
    observationId: `${agentId}:1`,
    agentId,
    provider: "provider",
    displayName,
    surfaces: ["cli" as const],
    supportedLevels: [1 as const, 2 as const],
    installation: { state: installation, evidence: [] },
    runtime: { state: runtime, processCount: runtime === "running" ? 1 : 0, evidence: [] },
    observedAt,
    errors: []
  });
  const viewModel = toPassportViewModel({
    passport,
    sharingBusy: false,
    openPanel: "sharing",
    agentManagement: {
      schemaVersion: 1,
      revision: 1,
      state: "ready",
      generatedAt: observedAt,
      completedAt: observedAt,
      pathOverrides: {},
      errors: [],
      agents: [
        observation("absent", "Absent", "not_installed", "not_running"),
        observation("installed-a", "Installed A", "installed", "not_running"),
        observation("running-a", "Running A", "installed", "running"),
        observation("unknown", "Unknown", "unknown", "unknown"),
        observation("running-b", "Running B", "installed", "running"),
        observation("installed-b", "Installed B", "installed", "unknown")
      ]
    }
  });

  assert.deepEqual(
    viewModel.settings.agentManagement.agents.map((agent) => agent.id),
    ["running-a", "running-b", "installed-a", "installed-b", "unknown", "absent"]
  );
});

test("confirmed peer cards present shared Agent Passport rows", () => {
  const passport = emptyPassportSnapshot();
  passport.connections = [{
    requestId: "request-1",
    connectionState: "Confirmed",
    direction: "incoming",
    identity: {
      tetiId: "teti_remote001",
      address: "remote001@mail.seep.im",
      displayName: "Remote"
    },
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    lastSeen: "2026-07-25T00:00:09.000Z",
    passport: {
      state: "fresh",
      resources: [],
      agents: [{
        id: "claude-code",
        name: "Claude Code",
        provider: "anthropic",
        type: "cli",
        surfaces: ["cli"],
        installationStatus: "installed",
        detectionSource: "command",
        version: "2.1.0",
        runtimeStatus: "running",
        processCount: 1,
        confidence: "high",
        observedAt: "2026-07-25T00:00:08.000Z"
      }]
    }
  }];

  const viewModel = toPassportViewModel(
    { passport, sharingBusy: false, openPanel: null },
    new Date("2026-07-25T00:00:10.000Z")
  );
  assert.equal(viewModel.connections[0]?.passport.note, undefined);
  assert.equal(viewModel.connections[0]?.passport.agents[0]?.name, "Claude Code");
  assert.equal(viewModel.connections[0]?.passport.agents[0]?.providerName, "Anthropic");
  assert.equal(viewModel.connections[0]?.passport.agents[0]?.statusLabel, "运行中");
});
