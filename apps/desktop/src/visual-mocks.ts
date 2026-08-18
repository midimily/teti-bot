import "./styles.css";
import type { PassportConnectionSnapshot } from "../../../core/passport/snapshot.ts";
import type { TetiCapabilityPassport } from "../../../core/passport/types.ts";
import {
  applyDocumentLocale,
  createDesktopI18n,
  type AppLocale,
  type AppLocalePreference
} from "./i18n/index.ts";
import {
  emptyPassportSnapshot,
  type PassportControllerSnapshot
} from "./passport/controller.ts";
import { createPassportSettingsPanel } from "./passport/view.ts";
import { toPassportViewModel } from "./passport/view-model.ts";
import type { TaskController, TaskControllerSnapshot } from "./tasks/controller.ts";
import { createTaskWorkspace } from "./tasks/view.ts";

const root = document.getElementById("app");
if (!root) throw new Error("Visual mock root is missing.");

const query = new URLSearchParams(window.location.search);
const locale: AppLocale = query.get("locale") === "zh-Hans" ? "zh-Hans" : "en";
const platform = query.get("platform") === "windows" ? "windows" : "macos";
const state = query.get("state") === "settings"
  ? "settings"
  : query.get("state") === "compose"
  ? "compose"
  : query.get("state") === "detail"
    ? "detail"
    : "inbox";
const i18n = createDesktopI18n(locale);
applyDocumentLocale(document, i18n);
document.documentElement.dataset.platform = platform;
document.documentElement.dataset.visualState = state;
document.body.dataset.visualMock = "task-localization";

function snapshotFor(screen: "inbox" | "compose" | "detail"): TaskControllerSnapshot {
  const base = {
    open: true,
    screen,
    summary: {
      schemaVersion: 1,
      generatedAt: now,
      pendingIncomingCount: 2,
      tasks: [
        {
          taskId: "task-pending-images",
          direction: "incoming",
          peerTetiId: peerConnection.identity.tetiId,
          state: "submitted",
          approval: "pending",
          attachmentsReady: false,
          cancelPending: false,
          artifactCount: 0,
          imageCount: 3,
          receivedImageCount: 2,
          textPreview: "Review the attached product mockups and prepare an implementation plan.",
          createdAt: "2026-08-18T09:16:00+08:00"
        },
        {
          taskId: "task-running",
          direction: "outgoing",
          peerTetiId: peerConnection.identity.tetiId,
          state: "working",
          approval: "approved_once",
          attachmentsReady: true,
          cancelPending: false,
          artifactCount: 1,
          imageCount: 0,
          receivedImageCount: 0,
          textPreview: "Summarize the API migration risks and publish an Artifact.",
          createdAt: "2026-08-18T08:02:00+08:00"
        }
      ]
    },
    selectedTask: screen === "detail" ? detailRecord : null,
    selectedExecution: screen === "detail" ? execution : null,
    delegationTargets: screen === "detail" ? delegationTargets : [],
    delegationSelections: screen === "detail" ? delegationTargets.slice(0, 2) : [],
    selectedImagePaths: {},
    draft: {
      connectionRequestId: peerConnection.requestId,
      offerId: "offer-vision-analysis",
      capabilityId: "vision-analysis",
      text: "Compare these product mockups, identify accessibility gaps, and return a prioritized implementation plan.",
      images: [],
      executionMode: "long_horizon"
    },
    busy: false
  };
  return base as unknown as TaskControllerSnapshot;
}

function mockController(snapshot: TaskControllerSnapshot): TaskController {
  return {
    get snapshot() { return snapshot; },
    back() {},
    openCompose() {},
    updateDraft() {},
    canSendDraft: () => true,
    attachImages: async () => undefined,
    removeDraftImage() {},
    send: async () => undefined,
    select: async () => undefined,
    openResultImage: async () => undefined,
    revealResultImage: async () => undefined,
    saveResultImage: async () => undefined,
    reject: async () => undefined,
    approve: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    submitInput: async () => undefined,
    pause: async () => undefined,
    continue: async () => undefined,
    complete: async () => undefined,
    renew: async () => undefined,
    setDelegationStep() {},
    removeDelegationStep() {},
    addDelegationStep() {},
    approveDelegation: async () => undefined
  } as unknown as TaskController;
}

const now = "2026-08-18T10:00:00+08:00";
const peerConnection = {
  requestId: "connection-alpha-mac",
  connectionState: "Confirmed",
  direction: "outgoing",
  identity: {
    tetiId: "teti_alpha0001",
    address: "alpha@example.invalid",
    displayName: "Alpha Studio Mac"
  },
  createdAt: now,
  updatedAt: now,
  confirmedAt: now,
  lastSeen: now,
  compatibility: "compatible",
  passport: {
    state: "fresh",
    resources: [],
    agents: [{
      id: "codex",
      name: "Codex",
      availability: "available",
      capabilityIds: ["vision-analysis"],
      inputModes: ["text", "image"],
      outputModes: ["text", "image"]
    }],
    capabilities: [{
      id: "vision-analysis",
      name: "Visual analysis and implementation planning",
      availability: "available"
    }],
    bindings: [{ capabilityId: "vision-analysis", agentIds: ["codex"] }],
    computeOffers: [{
      offerId: "offer-vision-analysis",
      capability: "vision-analysis"
    }]
  }
} as unknown as PassportConnectionSnapshot;

const localPassport = {
  agents: [{
    id: "codex",
    name: "Codex",
    availability: "available",
    capabilityIds: ["vision-analysis"],
    inputModes: ["text", "image"],
    outputModes: ["text"]
  }],
  bindings: [{ capabilityId: "vision-analysis", agentIds: ["codex"] }]
} as unknown as TetiCapabilityPassport;

const detailRecord = {
  schemaVersion: 1,
  direction: "incoming",
  peerTetiId: peerConnection.identity.tetiId,
  protocolVersion: 7,
  request: {
    schemaVersion: 7,
    taskId: "task-long-horizon-visual",
    requesterTetiId: peerConnection.identity.tetiId,
    targetTetiId: "teti_local0001",
    offerId: "offer-vision-analysis",
    capabilityId: "vision-analysis",
    input: {
      kind: "parts",
      parts: [
        { kind: "text", text: "Review the three attached product mockups, identify accessibility and localization risks, then produce an implementation-ready Artifact." },
        { kind: "image", attachmentId: "input-image-1", mimeType: "image/png", byteLength: 2048, width: 1200, height: 800, sha256: "a".repeat(64) }
      ]
    },
    workspace: { kind: "temporary", access: ["read", "write", "create_artifact"] },
    executionMode: "long_horizon",
    createdAt: "2026-08-18T09:16:00+08:00",
    expiresAt: "2026-08-18T18:30:00+08:00"
  },
  state: "working",
  approval: "pending",
  delivery: "received",
  attachmentsReady: true,
  artifactAttachmentsReady: false,
  artifacts: [{
    schemaVersion: 2,
    taskId: "task-long-horizon-visual",
    artifactId: "artifact-plan",
    parts: [
      { kind: "text", text: "1. Fix focus order and image alternatives.\n2. Add locale-safe layout constraints.\n3. Validate semantic progress on both Macs." },
      { kind: "image", attachmentId: "artifact-image-1", mimeType: "image/png", byteLength: 4096, width: 1280, height: 720, sha256: "b".repeat(64) }
    ],
    createdAt: now
  }],
  peerLongHorizon: {
    schemaVersion: 1,
    phase: "working",
    currentStageIndex: 3,
    workspaceRevision: 4,
    completedUnits: 2,
    totalUnits: 5,
    progressMessage: "接收端本机中文消息不应显示",
    continuationExpiresAt: "2026-08-18T18:30:00+08:00"
  },
  createdAt: "2026-08-18T09:16:00+08:00",
  updatedAt: now
};

const execution = {
  schemaVersion: 1,
  taskId: "task-long-horizon-visual",
  workspaceId: "workspace-visual",
  childAgentId: "codex",
  connectorId: "codex-adapter",
  executionEpoch: 2,
  providerExecutionId: null,
  leaseExpiresAt: now,
  progress: {
    state: "running",
    completedUnits: 2,
    totalUnits: 5,
    message: "接收端 Runtime 原始中文进度不应显示",
    updatedAt: now
  },
  checkpointRef: null,
  resumeCapability: "checkpoint_restart"
};

const delegationTargets = [{
  childAgentId: "codex",
  connectorId: "codex-adapter",
  capabilityId: "vision-analysis",
  resourceBindingId: "local.codex.primary",
  workspacePolicy: "snapshot",
  inputModes: ["text", "image"],
  outputModes: ["text"],
  timeoutMs: 300_000,
  maxOutputBytes: 57_344
}, {
  childAgentId: "osaurus-runtime",
  connectorId: "osaurus-native",
  capabilityId: "vision-analysis",
  resourceBindingId: "local.osaurus.fixed-agent",
  workspacePolicy: "bounded_context",
  inputModes: ["text", "image"],
  outputModes: ["text"],
  timeoutMs: 240_000,
  maxOutputBytes: 49_152
}];

root.replaceChildren(state === "settings"
  ? createSettingsVisualMock()
  : createTaskWorkspace(
      mockController(snapshotFor(state)),
      [peerConnection],
      localPassport,
      undefined,
      i18n
    ));

function createSettingsVisualMock(): HTMLElement {
  const passport = emptyPassportSnapshot(new Date(now));
  passport.identity = {
    tetiId: "teti_local0001",
    address: "local@example.invalid",
    displayName: "Studio Teti"
  };
  passport.networkIdentity = { state: "active", checkedAt: now };
  const snapshot = {
    passport,
    agentManagement: {
      schemaVersion: 1,
      revision: 1,
      state: "ready",
      generatedAt: now,
      agents: [],
      pathOverrides: {},
      errors: []
    },
    sharingBusy: false,
    agentBusy: false,
    openPanel: "sharing",
    networkEnvironment: {
      schemaVersion: 1,
      useLocalDevelopmentNetwork: false,
      activeEnvironment: "production",
      activeBaseUrl: "https://network.teti.bot",
      configuredEnvironment: "production",
      configuredBaseUrl: "https://network.teti.bot",
      restartRequired: false
    },
    networkEnvironmentBusy: false,
    presence: {
      schemaVersion: 1,
      state: "online",
      mode: "online",
      sessionId: "visual-settings",
      sequence: 1,
      foreground: true,
      panelVisible: true,
      collaborationActive: false
    }
  } as unknown as PassportControllerSnapshot;
  const model = toPassportViewModel(snapshot, new Date(now), i18n);
  const requestedPreference = query.get("preference");
  const preference: AppLocalePreference = requestedPreference === "zh-Hans" || requestedPreference === "en"
    ? requestedPreference
    : "auto";
  const panel = createPassportSettingsPanel(
    model.settings,
    undefined,
    undefined,
    [],
    i18n,
    {
      preference,
      setPreference(nextPreference) {
        document.documentElement.dataset.selectedPreference = nextPreference;
      }
    }
  );
  panel.hidden = false;
  const shell = document.createElement("section");
  shell.className = "teti-visual-settings-shell";
  shell.append(panel);
  return shell;
}
