import assert from "node:assert/strict";
import test from "node:test";
import { emptyPassportSnapshot } from "../src/passport/controller.ts";
import {
  formatOsaurusNativeReason,
  formatLocalTetiIdentity,
  formatResetAt,
  toAgentViewModel,
  toPassportViewModel
} from "../src/passport/view-model.ts";

test("Osaurus Native accepted risks use user-facing copy", () => {
  assert.equal(
    formatOsaurusNativeReason("OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED"),
    "Osaurus Insights 会保留请求正文；已按本机 Agent 信任策略允许调用。"
  );
  assert.equal(formatOsaurusNativeReason("OSAURUS_RUNTIME_UNTRUSTED"), "OSAURUS_RUNTIME_UNTRUSTED");
});

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
  assert.ok(viewModel.settings.appVersion.length > 0);
  assert.ok(viewModel.settings.buildTimestamp.length > 0);
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

test("Presence shows authentication failures instead of reporting Network unavailable", () => {
  const passport = emptyPassportSnapshot();
  const viewModel = toPassportViewModel({
    passport,
    sharingBusy: false,
    openPanel: "sharing",
    presence: {
      schemaVersion: 1,
      state: "unavailable",
      mode: "online",
      sessionId: "ps_test-session",
      sequence: 0,
      foreground: true,
      panelVisible: false,
      collaborationActive: false,
      errorCode: "NETWORK_UNAUTHORIZED"
    }
  });

  assert.equal(viewModel.settings.presenceLabel, "Network 身份认证失败");
  assert.equal(viewModel.settings.presenceTone, "error");
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
    version: "codex-cli 1.2.3",
    installationStatus: "installed",
    runtimeStatus: "not_running"
  });
  assert.equal(installed.providerName, "OpenAI");
  assert.equal(installed.versionLabel, "codex-cli 1.2.3");
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

test("Agent management shows only locally installed or running Agents", () => {
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
    ["running-a", "running-b", "installed-a", "installed-b"]
  );
  assert.equal(viewModel.settings.agentManagement.statusLabel, "已发现 4");
});

test("Osaurus Native configuration is shown only when Osaurus exists locally", () => {
  const passport = emptyPassportSnapshot();
  const observedAt = "2026-07-25T00:00:00.000Z";
  const snapshot = {
    passport,
    sharingBusy: false,
    openPanel: "sharing" as const,
    agentManagement: {
      schemaVersion: 1 as const,
      revision: 1,
      state: "ready" as const,
      generatedAt: observedAt,
      completedAt: observedAt,
      pathOverrides: {},
      errors: [],
      agents: [{
        schemaVersion: 1 as const,
        observationId: "osaurus:1",
        agentId: "osaurus",
        provider: "osaurus",
        displayName: "Osaurus",
        surfaces: ["desktop" as const, "local_service" as const],
        supportedLevels: [1 as const, 2 as const],
        installation: { state: "not_installed" as const, evidence: [] },
        runtime: { state: "not_running" as const, processCount: 0, evidence: [] },
        observedAt,
        errors: []
      }]
    }
  };

  assert.equal(toPassportViewModel(snapshot).settings.showOsaurusNativeConfiguration, false);
  snapshot.agentManagement.agents[0]!.installation.state = "installed";
  assert.equal(toPassportViewModel(snapshot).settings.showOsaurusNativeConfiguration, true);
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
    compatibility: "compatible",
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
  assert.equal(viewModel.connections[0]?.identityLabel, "Remote（remote001）");
  assert.equal("address" in viewModel.connections[0]!, false);
  assert.equal(viewModel.connections[0]?.passport.note, undefined);
  assert.equal(viewModel.connections[0]?.passport.agents[0]?.name, "Claude Code");
  assert.equal(viewModel.connections[0]?.passport.agents[0]?.providerName, "Anthropic");
  assert.equal(viewModel.connections[0]?.passport.agents[0]?.statusLabel, "运行中");
});

test("remote AI card summary keeps one Resource, two Agents, and two Capabilities", () => {
  const passport = emptyPassportSnapshot();
  const observedAt = "2026-07-25T00:00:00.000Z";
  passport.connections = [{
    requestId: "summary-peer",
    connectionState: "Confirmed",
    direction: "incoming",
    identity: {
      tetiId: "teti_remote001",
      address: "remote001@mail.seep.im",
      displayName: "Remote"
    },
    createdAt: observedAt,
    updatedAt: observedAt,
    lastSeen: observedAt,
    compatibility: "compatible",
    passport: {
      state: "fresh",
      resources: ["Codex", "Local Model", "Compute"].map((product, index) => ({
        id: `resource-${index}`,
        provider: `provider-${index}`,
        product,
        kind: "subscription" as const,
        plan: { key: "plus", displayName: "Plus" },
        availability: "available" as const,
        quotas: index === 0 ? [{
          period: "week",
          remainingPercent: 55,
          resetAt: "2026-08-01T08:30:00.000Z",
          windowSeconds: 604_800,
          identification: "exact" as const
        }] : [],
        assurance: "provider_observed" as const,
        observedAt
      })),
      agents: ["Codex", "CodeBuddy", "Osaurus"].map((name, index) => ({
        id: `agent-${index}`,
        name,
        provider: `provider-${index}`,
        capabilityIds: [`capability-${index}`],
        inputModes: ["text" as const],
        outputModes: ["text" as const],
        availability: "available" as const,
        observedAt
      })),
      capabilities: ["Code", "Image", "Research", "Document"].map((name, index) => ({
        id: `capability-${index}`,
        name,
        category: "collaboration",
        description: `${name} capability`,
        availability: "available" as const,
        observedAt
      })),
      bindings: [{
        capabilityId: "capability-0",
        agentIds: ["agent-0"],
        resourceIds: ["resource-0"]
      }]
    }
  }];

  const card = toPassportViewModel(
    { passport, sharingBusy: false, openPanel: null },
    new Date("2026-07-25T00:00:01.000Z")
  ).connections[0]!;
  assert.equal(card.identityLabel, "Remote（remote001）");
  assert.equal(card.passport.summary.resource?.productName, "Codex");
  assert.equal(card.passport.summary.resourceOverflowCount, 2);
  assert.deepEqual(card.passport.summary.agents.map((agent) => agent.name), ["Codex", "CodeBuddy"]);
  assert.equal(card.passport.summary.agentOverflowCount, 1);
  assert.deepEqual(card.passport.summary.capabilities.map((capability) => capability.name), ["Code", "Image"]);
  assert.equal(card.passport.summary.capabilityOverflowCount, 2);
  assert.equal(card.passport.resources.length, 3, "full Resource detail remains available");
  assert.equal(card.passport.resources[0]?.quotas[0]?.periodLabel, "周额度");
  assert.equal(card.passport.resources[0]?.quotas[0]?.remainingPercent, 55);
  assert.equal(card.passport.agents.length, 3, "full Agent detail remains available");
  assert.equal(card.passport.agents[0]?.versionLabel, "版本未共享");
  assert.deepEqual(card.passport.agents[0]?.inputModeLabels, ["文本"]);
  assert.equal(card.passport.providers.length, 3, "Provider detail is grouped without flattening into the card");
  assert.equal(card.passport.capabilities.length, 4, "full Capability detail remains available");
  assert.deepEqual(card.passport.capabilities[0]?.bindings, [{
    agentNames: ["Codex"],
    resourceNames: ["Codex"],
    statusLabel: "绑定完整"
  }]);
});

test("legacy peer compatibility is separate from reachability", () => {
  const passport = emptyPassportSnapshot();
  passport.connections = [{
    requestId: "legacy-peer",
    connectionState: "Confirmed",
    direction: "incoming",
    identity: { tetiId: "teti_remote001", address: "remote001@mail.seep.im" },
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    lastSeen: "2026-07-25T00:00:09.000Z",
    compatibility: "upgrade_required",
    passport: { state: "unknown", resources: [], agents: [], capabilities: [], bindings: [] }
  }];
  const viewModel = toPassportViewModel(
    { passport, sharingBusy: false, openPanel: null },
    new Date("2026-07-25T00:00:10.000Z")
  );
  assert.equal(viewModel.connections[0]?.reachability, "reachable");
  assert.equal(viewModel.connections[0]?.compatibility, "upgrade_required");
  assert.equal(viewModel.connections[0]?.compatibilityLabel, "需要升级");
});
