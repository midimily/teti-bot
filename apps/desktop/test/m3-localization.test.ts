import assert from "node:assert/strict";
import test from "node:test";
import type { FirstLaunchSnapshot } from "../src/first-launch/state-machine.ts";
import { toFirstLaunchViewModel } from "../src/first-launch/view-model.ts";
import { connectPanelMessage } from "../src/connections/connect-panel-message.ts";
import { emptyPassportSnapshot } from "../src/passport/controller.ts";
import {
  toPassportViewModel,
  toResourceViewModel
} from "../src/passport/view-model.ts";
import {
  createDesktopI18n,
  formatMessage
} from "../src/i18n/index.ts";

const english = createDesktopI18n("en");
const chinese = createDesktopI18n("zh-Hans");

test("First Launch derives English and Chinese copy from the injected locale", () => {
  const welcome: FirstLaunchSnapshot = {
    state: "welcome",
    nameInput: "",
    submitting: false
  };
  const invalidName: FirstLaunchSnapshot = {
    state: "recoverable_error",
    nameInput: "一二三四五六七八九十甲",
    submitting: false,
    error: {
      kind: "invalid_name",
      recoverable: true,
      diagnosticCode: "FL-NAME",
      validationReason: "too_long"
    }
  };

  assert.deepEqual(
    [
      toFirstLaunchViewModel(welcome, english).title,
      toFirstLaunchViewModel(welcome, english).primaryAction,
      toFirstLaunchViewModel(invalidName, english).input?.error
    ],
    ["Hello, human.", "Continue", "Names can contain at most 10 characters."]
  );
  assert.deepEqual(
    [
      toFirstLaunchViewModel(welcome, chinese).title,
      toFirstLaunchViewModel(welcome, chinese).primaryAction,
      toFirstLaunchViewModel(invalidName, chinese).input?.error
    ],
    ["你好，主人。", "下一步", "名字最多 10 个字符。"]
  );
});

test("Shell, update blocker, toolbar, brand, and connect panel expose both catalogs", () => {
  assert.equal(english.messages.shell.openTeti, "Open Teti");
  assert.equal(chinese.messages.shell.openTeti, "打开 Teti");
  assert.equal(english.messages.toolbar.collaborationTasks, "Collaboration tasks");
  assert.equal(chinese.messages.toolbar.collaborationTasks, "协作任务");
  assert.equal(
    formatMessage(english.messages.brand.websiteLabel, { brand: "Teti.bot" }),
    "Visit the Teti.bot website"
  );
  assert.equal(
    formatMessage(chinese.messages.updateBlocker.status, {
      currentVersion: "0.3.9",
      minimumVersion: "0.4.0",
      buildTimestamp: "2026-08-18T00:00:00Z"
    }),
    "本机 0.3.9 · 最低支持 0.4.0 · 构建 2026-08-18T00:00:00Z"
  );
  assert.equal(connectPanelMessage("connected", english), "Connected");
  assert.equal(connectPanelMessage("connected", chinese), "已成功建联");
});

test("connection list and remote Passport details localize from semantic state", () => {
  const passport = emptyPassportSnapshot();
  passport.connections = [{
    requestId: "peer-1",
    connectionState: "Confirmed",
    direction: "incoming",
    identity: {
      tetiId: "teti_remote001",
      address: "remote001@mail.seep.im",
      displayName: "Remote"
    },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    confirmedAt: "2026-08-18T00:00:00.000Z",
    lastSeen: "2026-08-18T00:00:09.000Z",
    compatibility: "upgrade_required",
    passport: {
      state: "disabled",
      resources: [],
      agents: [],
      capabilities: [],
      bindings: [],
      computeOffers: []
    }
  }];
  const snapshot = { passport, sharingBusy: false, openPanel: null } as const;
  const now = new Date("2026-08-18T00:00:10.000Z");
  const englishCard = toPassportViewModel(snapshot, now, english).connections[0]!;
  const chineseCard = toPassportViewModel(snapshot, now, chinese).connections[0]!;

  assert.deepEqual(
    [englishCard.identityLabel, englishCard.compatibilityLabel, englishCard.reachabilityLabel,
      englishCard.passport.note],
    ["Remote (remote001)", "Update required", "Online",
      "The other Teti isn’t sharing its AI Passport"]
  );
  assert.deepEqual(
    [chineseCard.identityLabel, chineseCard.compatibilityLabel, chineseCard.reachabilityLabel,
      chineseCard.passport.note],
    ["Remote（remote001）", "需要升级", "在线", "对方未分享 AI Passport"]
  );

  const resource = {
    id: "openai.codex",
    provider: "openai",
    product: "Codex",
    kind: "subscription" as const,
    plan: { key: "plus", displayName: "Plus" },
    availability: "available" as const,
    quotas: [{
      period: "week",
      remainingPercent: 55,
      resetAt: null,
      windowSeconds: 604_800,
      identification: "exact" as const
    }],
    assurance: "provider_observed" as const,
    observedAt: "2026-08-18T00:00:00.000Z"
  };
  assert.deepEqual(
    [
      toResourceViewModel(resource, english).kindLabel,
      toResourceViewModel(resource, english).quotas[0]?.periodLabel,
      toResourceViewModel(resource, english).quotas[0]?.windowLabel
    ],
    ["Subscription resource", "Weekly quota", "7 days window"]
  );
  assert.deepEqual(
    [
      toResourceViewModel(resource, chinese).kindLabel,
      toResourceViewModel(resource, chinese).quotas[0]?.periodLabel,
      toResourceViewModel(resource, chinese).quotas[0]?.windowLabel
    ],
    ["订阅资源", "周额度", "7 天窗口"]
  );
});
