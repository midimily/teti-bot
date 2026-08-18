import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentManagementSnapshot } from "../../../core/observation/management.ts";
import type { PassportControllerSnapshot } from "../src/passport/controller.ts";
import { emptyPassportSnapshot } from "../src/passport/controller.ts";
import { createDesktopI18n } from "../src/i18n/index.ts";
import { memoryErrorMessage } from "../src/memory/message.ts";
import { toPassportViewModel } from "../src/passport/view-model.ts";
import { languagePreferenceOptions } from "../src/passport/view.ts";

const english = createDesktopI18n("en");
const chinese = createDesktopI18n("zh-Hans");
const observedAt = "2026-08-18T00:00:00.000Z";

test("local AI Passport, Codex Usage, Agent status, and capabilities localize from data", () => {
  const passport = emptyPassportSnapshot(new Date(observedAt));
  passport.localPassport.resources[0] = {
    id: "openai.codex",
    provider: "openai",
    product: "Codex",
    kind: "subscription",
    plan: { key: "plus", displayName: "Plus" },
    availability: "available",
    quotas: [{
      period: "week",
      remainingPercent: 64,
      resetAt: null,
      windowSeconds: 604_800,
      identification: "exact"
    }],
    assurance: "provider_observed",
    observedAt
  };
  passport.localPassport.agents = [{
    id: "codex-callable",
    name: "Codex",
    provider: "openai",
    capabilityIds: ["coding"],
    inputModes: ["text", "image"],
    outputModes: ["text"],
    availability: "available",
    observedAt
  }];
  passport.localPassport.capabilities = [{
    id: "coding",
    name: "Coding",
    category: "coding",
    description: "Writes code",
    availability: "available",
    observedAt
  }];

  const snapshot = baseSnapshot(passport);
  const en = toPassportViewModel(snapshot, new Date(observedAt), english);
  const zh = toPassportViewModel(snapshot, new Date(observedAt), chinese);

  assert.deepEqual(
    [en.aiPanel.title, en.aiPanel.resources[0]?.kindLabel,
      en.aiPanel.resources[0]?.quotas[0]?.periodLabel,
      en.aiPanel.resources[0]?.quotas[0]?.windowLabel,
      en.aiPanel.agents[0]?.statusLabel, en.aiPanel.agents[0]?.inputModeLabels,
      en.aiPanel.capabilities[0]?.categoryLabel, en.aiPanel.capabilities[0]?.availabilityLabel],
    ["AI Passport", "Subscription resource", "Weekly quota", "7 days window",
      "Callable", ["Text", "Image"], "Coding", "Available"]
  );
  assert.deepEqual(
    [zh.aiPanel.title, zh.aiPanel.resources[0]?.kindLabel,
      zh.aiPanel.resources[0]?.quotas[0]?.periodLabel,
      zh.aiPanel.resources[0]?.quotas[0]?.windowLabel,
      zh.aiPanel.agents[0]?.statusLabel, zh.aiPanel.agents[0]?.inputModeLabels,
      zh.aiPanel.capabilities[0]?.categoryLabel, zh.aiPanel.capabilities[0]?.availabilityLabel],
    ["AI Passport", "订阅资源", "周额度", "7 天窗口",
      "可调用", ["文本", "图片"], "编程", "可用"]
  );
});

test("Settings, local reset, Network environment, and presence use the injected locale", () => {
  const passport = emptyPassportSnapshot(new Date(observedAt));
  passport.identity = {
    tetiId: "teti_abc123xyz",
    address: "abc123xyz@mail.seep.im",
    displayName: "Max"
  };
  passport.networkIdentity = {
    state: "active",
    checkedAt: observedAt
  };
  const snapshot: PassportControllerSnapshot = {
    ...baseSnapshot(passport),
    sharingErrorCode: "sharing_save_failed",
    networkEnvironment: {
      schemaVersion: 1,
      useLocalDevelopmentNetwork: true,
      activeEnvironment: "local_development",
      activeBaseUrl: "http://127.0.0.1:8787",
      configuredEnvironment: "production",
      configuredBaseUrl: "https://network.teti.bot",
      restartRequired: true
    },
    networkEnvironmentErrorCode: "network_environment_save_failed",
    networkContract: {
      state: "compatible",
      checkedAt: observedAt,
      protocolVersion: 1,
      contractRevision: 8,
      serviceVersion: "0.4.0"
    },
    presence: {
      schemaVersion: 1,
      state: "online",
      mode: "collaborating",
      sessionId: "presence-1",
      sequence: 2,
      foreground: true,
      panelVisible: true,
      collaborationActive: true
    },
    localLogoutErrorCode: "local_profile_logout_failed"
  };

  const en = toPassportViewModel(snapshot, new Date(observedAt), english).settings;
  const zh = toPassportViewModel(snapshot, new Date(observedAt), chinese).settings;

  assert.deepEqual(
    [en.title, en.identityLabel, en.networkIdentityLabel, en.toggleLabel,
      en.networkEnvironmentActiveLabel, en.presenceLabel, en.networkVersionLabel],
    ["Settings", "Max (abc123xyz)", "Connected to Network", "Passport sharing",
      "Local development", "Connected · AI collaboration active", "Protocol 1 · Service 0.4.0"]
  );
  assert.deepEqual(
    [zh.title, zh.identityLabel, zh.networkIdentityLabel, zh.toggleLabel,
      zh.networkEnvironmentActiveLabel, zh.presenceLabel, zh.networkVersionLabel],
    ["设置", "Max（abc123xyz）", "已连接 Network", "Passport 分享",
      "本机开发环境", "已连接 · AI 协作中", "Protocol 1 · Service 0.4.0"]
  );
  assert.equal(en.error, "Passport sharing settings couldn’t be saved.");
  assert.equal(zh.error, "Passport 分享设置暂时无法保存。");
  assert.equal(en.networkEnvironmentError, "The Network development setting couldn’t be saved.");
  assert.equal(zh.networkEnvironmentError, "Network 开发环境设置暂时无法保存。");
  assert.equal(en.localLogoutError, "Teti couldn’t be reset on this device. Quit the app and try again.");
  assert.equal(zh.localLogoutError, "无法重置本机 Teti，请退出 App 后重试。");
});

test("Settings exposes automatic, Chinese, and English language choices above Network", async () => {
  assert.deepEqual(languagePreferenceOptions(english), [
    { value: "auto", label: "Automatic detection" },
    { value: "zh-Hans", label: "中文" },
    { value: "en", label: "English" }
  ]);
  assert.deepEqual(languagePreferenceOptions(chinese), [
    { value: "auto", label: "自动检测" },
    { value: "zh-Hans", label: "中文" },
    { value: "en", label: "English" }
  ]);
  const source = await readFile(new URL("../src/passport/view.ts", import.meta.url), "utf8");
  const languagePosition = source.indexOf("panel.append(createLanguageSetting");
  const networkPosition = source.indexOf("panel.append(networkEnvironment)");
  assert.ok(languagePosition >= 0);
  assert.ok(networkPosition > languagePosition);
  assert.match(source, /select\.dataset\.focusKey = "settings-language"/);
  assert.match(source, /settings\.setPreference\(select\.value\)/);
});

test("Agent management and Osaurus preserve semantic state while localizing copy", () => {
  const passport = emptyPassportSnapshot(new Date(observedAt));
  const agentManagement: AgentManagementSnapshot = {
    schemaVersion: 1,
    revision: 1,
    state: "ready",
    generatedAt: observedAt,
    agents: [{
      schemaVersion: 1,
      observationId: "observation-osaurus",
      agentId: "osaurus",
      provider: "Osaurus",
      displayName: "Osaurus",
      surfaces: ["desktop"],
      supportedLevels: [1, 2],
      installation: { state: "installed", version: "1.2.3", evidence: [] },
      runtime: { state: "not_running", evidence: [] },
      observedAt,
      errors: []
    }],
    pathOverrides: {},
    errors: []
  };
  const snapshot: PassportControllerSnapshot = {
    ...baseSnapshot(passport),
    agentManagement,
    osaurusNative: {
      schemaVersion: 1,
      agentId: "0f526828-077d-4d0f-9e06-d8d2e157b133",
      readiness: "blocked",
      reasonCode: "OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED"
    },
    osaurusNativeErrorCode: "osaurus_native_save_failed"
  };

  const en = toPassportViewModel(snapshot, new Date(observedAt), english).settings;
  const zh = toPassportViewModel(snapshot, new Date(observedAt), chinese).settings;

  assert.equal(en.agentManagement.statusLabel, "Found 1");
  assert.equal(zh.agentManagement.statusLabel, "已发现 1");
  assert.equal(en.agentManagement.agents[0]?.statusLabel, "Installed");
  assert.equal(zh.agentManagement.agents[0]?.statusLabel, "已安装");
  assert.equal(en.showOsaurusNativeConfiguration, true);
  assert.equal(en.osaurusNativeState, "blocked");
  assert.equal(zh.osaurusNativeState, "blocked");
  assert.equal(en.osaurusNativeStatus, "Security qualification failed");
  assert.equal(zh.osaurusNativeStatus, "安全资格未通过");
  assert.equal(
    en.osaurusNativeReason,
    "Osaurus Insights retains request bodies; calls are allowed under the local Agent trust policy."
  );
  assert.equal(
    zh.osaurusNativeReason,
    "Osaurus Insights 会保留请求正文；已按本机 Agent 信任策略允许调用。"
  );
  assert.equal(en.osaurusNativeError, "The fixed Agent ID is invalid or the local setting couldn’t be saved.");
  assert.equal(zh.osaurusNativeError, "固定 Agent ID 无效，或本机配置暂时无法保存。");
});

test("Child Memory settings, task copy, and safe error codes expose both catalogs", () => {
  assert.equal(memoryErrorMessage("authorization_required", english),
    "Explicitly enable the matching long-term Memory authorization first.");
  assert.equal(memoryErrorMessage("authorization_required", chinese),
    "请先显式开启对应的长期 Memory 授权。");
  assert.equal(memoryErrorMessage("operation_failed", english),
    "The local Child Memory operation didn’t finish. Check the authorization and task state, then try again.");
  assert.equal(memoryErrorMessage("operation_failed", chinese),
    "本机 Child Memory 操作未完成，请检查授权与任务状态后重试。");
  assert.deepEqual(
    [english.messages.memory.title, english.messages.memory.exportAction,
      english.messages.memory.task.childDescription, english.messages.memory.task.saveResult,
      english.messages.passport.settings.build.resetLocalTeti],
    ["Child Memory", "Export", "Available only to later tasks from the same Child Agent",
      "Save result", "Reset Teti"]
  );
  assert.deepEqual(
    [chinese.messages.memory.title, chinese.messages.memory.exportAction,
      chinese.messages.memory.task.childDescription, chinese.messages.memory.task.saveResult,
      chinese.messages.passport.settings.build.resetLocalTeti],
    ["Child Memory", "导出", "仅供同一 Child Agent 后续任务检索", "保存结果", "重置本机 Teti"]
  );
});

test("local reset copy states the destructive local scope without claiming server deletion", () => {
  assert.deepEqual(
    [english.messages.passport.settings.build.resetLocalTeti,
      english.messages.passport.settings.build.resetting,
      english.messages.passport.settings.build.cancelReset,
      english.messages.passport.settings.build.confirmReset],
    ["Reset Teti", "Resetting…", "Cancel reset", "Erase and reset"]
  );
  assert.match(english.messages.passport.settings.build.warning, /permanently erases/);
  assert.match(english.messages.passport.settings.build.warning, /server-side identity and data are not deleted/);
  assert.deepEqual(
    [chinese.messages.passport.settings.build.resetLocalTeti,
      chinese.messages.passport.settings.build.resetting,
      chinese.messages.passport.settings.build.cancelReset,
      chinese.messages.passport.settings.build.confirmReset],
    ["重置本机 Teti", "正在重置…", "取消重置", "清除并重置"]
  );
  assert.match(chinese.messages.passport.settings.build.warning, /永久清除/);
  assert.match(chinese.messages.passport.settings.build.warning, /服务器端身份及数据不会被删除/);
});

function baseSnapshot(
  passport: ReturnType<typeof emptyPassportSnapshot>
): PassportControllerSnapshot {
  return {
    passport,
    agentManagement: {
      schemaVersion: 1,
      revision: 0,
      state: "idle",
      generatedAt: observedAt,
      agents: [],
      pathOverrides: {},
      errors: []
    },
    sharingBusy: false,
    agentBusy: false,
    openPanel: "sharing"
  };
}
