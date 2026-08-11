import { createInterface } from "node:readline";
import { watch } from "node:fs";
import { stdin, stdout, stderr } from "node:process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIFECYCLE_PROTOCOL_VERSION,
  type LifecycleResponse
} from "../src/lifecycle-bridge/protocol.ts";
import {
  defaultLifecycleSidecarDependencies,
  createGuardedRealTetiAccount,
  handleLifecycleLine,
  type LifecycleSidecarDependencies
} from "./handler.ts";
import { createLifecycleError, redactSecretLikeText } from "./security.ts";
import { getDefaultCodexUsageService } from "./codex-usage/runtime.ts";
import { TetiRuntime } from "./runtime/service.ts";
import { createRuntimeOwnedLifecycleDependencies } from "./runtime/lifecycle-adapter.ts";
import { SafeProcessWriter } from "./runtime/safe-output.ts";
import {
  acquireTetiRuntimeProfileLock,
  type TetiRuntimeProfileLock
} from "./runtime/profile-lock.ts";
import {
  ensureProfileBootstrapDirectories,
  ensureProfileDirectories,
  resolveTetiProfile
} from "./profile.ts";
import {
  closeDefaultPeerConnectionService,
  getDefaultPeerConnectionService,
  getDefaultPassportSharingStore
} from "./connections.ts";
import { writeRuntimeDiagnostic } from "./diagnostics.ts";
import {
  FileAgentDetectorConfiguration,
  loadAgentDetectorCatalog
} from "./runtime/agents/config.ts";
import { AgentObserverSupervisor } from "./runtime/agents/supervisor.ts";
import { createMacAgentObserverSystem } from "./runtime/agents/system.ts";
import { TetiHostAgentKernel } from "./runtime/callable/kernel.ts";
import { CallableQualificationSupervisor } from "./runtime/callable/qualification-supervisor.ts";
import { qualifyCodexConnector } from "../../../integrations/agents/codex/adapter.ts";
import { CodexImageConnector } from "../../../integrations/agents/codex/image-adapter.ts";
import { qualifyCodeBuddyConnector } from "../../../integrations/agents/codebuddy/qualification.ts";
import { FileTaskAttachmentStore } from "./runtime/tasks/attachments.ts";
import { FileCollaborationWorkspaceStore } from "./runtime/workspaces/store.ts";
import { ProcessTransport } from "./runtime/callable/transports/process.ts";
import {
  LoopbackHttpTransport,
  OsaurusAgentTransport
} from "./runtime/callable/transports/loopback-http.ts";
import { qualifyOsaurusConnector } from "../../../integrations/agents/osaurus/connector.ts";
import {
  FileOsaurusNativeAgentPolicyAuditor,
  OSAURUS_NATIVE_CHILD,
  qualifyOsaurusNativeConnector,
  readOsaurusNativeChildConfiguration,
  writeOsaurusNativeChildConfiguration
} from "../../../integrations/agents/osaurus/native-agent.ts";
import { OsaurusRuntimeIdentityVerifier } from "../../../integrations/agents/osaurus/runtime-identity.ts";
import {
  DurableExecutionRegistry,
  FileExecutionHandleStore
} from "./runtime/callable/execution-store.ts";
import {
  ChildMemoryService,
  FileChildMemoryStore
} from "./runtime/memory/service.ts";
import {
  FileReleasePolicyStore,
  NetworkBootstrapReleasePolicyClient,
  LocalReleasePolicyService
} from "./runtime/release/service.ts";
import { TETI_BUILD_INFO } from "../src/build-info.ts";
import { HttpTetiNetworkClient } from "../../../services/network/client.ts";
import { TetiNetworkPublicReadAdapter } from "../../../services/network/public-read-adapter.ts";
import { FileTetiAccountStorage } from "../../../core/account/storage.ts";
import { FileTetiNetworkCredentialStore } from "../../../services/network/credential-store.ts";
import {
  DEVELOPMENT_FIRST_CLAIM_ADOPTION_GRANT,
  TETI_NETWORK_ADOPTION_GRANT,
  TetiNetworkIdentityService
} from "../../../services/network/identity-service.ts";
import { RuntimePresencePolicyController } from "./runtime/presence/controller.ts";
import {
  FileTetiNetworkEnvironmentPreferenceStore,
  TetiNetworkEnvironmentSettingsService
} from "./runtime/network/environment.ts";
import { FileTetiNetworkProfileSyncStore } from "../../../services/network/profile-sync-store.ts";
import { TetiNetworkProfileService } from "../../../services/network/profile-service.ts";
import { FileTetiNetworkRelayBindingStore } from "../../../services/network/relay-binding-store.ts";
import {
  TETI_NETWORK_RELAY_BINDING_ADOPTION_GRANT,
  TetiNetworkRelayService
} from "../../../services/network/relay-service.ts";
import { FileTetiNetworkRelationshipCommandStore } from "../../../services/network/relationship-command-store.ts";
import { TetiNetworkRelationshipService } from "../../../services/network/relationship-service.ts";
import {
  FileTetiNetworkRelationshipReconciliationStore
} from "../../../services/network/relationship-reconciliation-store.ts";
import { projectNetworkPublicProfile } from "./runtime/network/public-profile.ts";

const PROCESS_SHUTDOWN_HARD_LIMIT_MS = 4_000;
const OSAURUS_QUALIFICATION_RETRY_MS = 15_000;
const inFlightRequestIds = new Set<string>();
let runtime: TetiRuntime | undefined;
let lifecycleDependencies: LifecycleSidecarDependencies | undefined;
let profileLock: TetiRuntimeProfileLock | undefined;
let shutdownPromise: Promise<void> | undefined;
const safeStdout = new SafeProcessWriter(stdout, () => { void beginShutdown(0); });
const safeStderr = new SafeProcessWriter(stderr, () => { void beginShutdown(0); });

process.on("uncaughtException", (error) => {
  safeStderr.write(`teti-lifecycle-sidecar uncaught: ${redactSecretLikeText(error.message)}\n`);
  void beginShutdown(1);
});

process.on("unhandledRejection", (reason) => {
  safeStderr.write(`teti-lifecycle-sidecar unhandled: ${redactSecretLikeText(String(reason))}\n`);
  void beginShutdown(1);
});

process.once("SIGTERM", () => { void beginShutdown(0); });
process.once("SIGINT", () => { void beginShutdown(0); });

try {
  await startSidecar();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  safeStderr.write(`teti-lifecycle-sidecar startup failed: ${redactSecretLikeText(message)}\n`);
  await beginShutdown(1);
}

async function startSidecar(): Promise<void> {
  const profile = await resolveTetiProfile();
  await ensureProfileBootstrapDirectories(profile);
  profileLock = await acquireTetiRuntimeProfileLock(profile);
  await ensureProfileDirectories(profile);
  const networkEnvironmentSettings = await TetiNetworkEnvironmentSettingsService.create(
    new FileTetiNetworkEnvironmentPreferenceStore(profile.networkEnvironmentPath)
  );
  const networkBaseUrl = networkEnvironmentSettings.settings.activeBaseUrl;
  const networkEnvironment = networkEnvironmentSettings.settings.activeEnvironment;
  const networkStatePaths = profile.networkStatePaths[networkEnvironment];
  const networkClient = new HttpTetiNetworkClient({
    baseUrl: networkBaseUrl,
    clientVersion: TETI_BUILD_INFO.appVersion,
    clientPlatform: "macos"
  });
  const accountStorage = new FileTetiAccountStorage(profile.accountPath);
  const networkIdentityService = new TetiNetworkIdentityService({
    client: networkClient,
    accountStorage,
    credentialStore: new FileTetiNetworkCredentialStore(networkStatePaths.credentialsPath),
    environment: networkEnvironment,
    appVersion: TETI_BUILD_INFO.appVersion,
    platform: "macos",
    adoptionGrant: resolveNetworkAdoptionGrant(networkBaseUrl)
  });
  let networkIdentityReady = false;
  let networkIdentityInitialization: Promise<void> | undefined;
  const synchronizeNetworkIdentity = async () => {
    const account = await networkIdentityService.synchronize();
    networkIdentityReady = true;
    return account;
  };
  const getNetworkAuthentication = async () => {
    if (!networkIdentityReady) {
      networkIdentityInitialization ??= synchronizeNetworkIdentity().then(() => undefined).finally(() => {
        networkIdentityInitialization = undefined;
      });
      await networkIdentityInitialization;
    }
    return networkIdentityService.getAuthenticatedSigner();
  };
  const networkRelayService = new TetiNetworkRelayService({
    client: networkClient,
    accountStorage,
    store: new FileTetiNetworkRelayBindingStore(networkStatePaths.relayBindingPath),
    environment: networkEnvironment,
    getAuthentication: getNetworkAuthentication,
    adoptionGrant: process.env[TETI_NETWORK_RELAY_BINDING_ADOPTION_GRANT]
  });
  const presenceController = new RuntimePresencePolicyController({
    client: networkClient,
    getAuthentication: getNetworkAuthentication,
    onChange: (snapshot) => {
      writeRuntimeDiagnostic("network.presence", {
        state: snapshot.state,
        mode: snapshot.mode,
        sequence: snapshot.sequence,
        code: snapshot.errorCode
      });
    }
  });
  const releasePolicyService = new LocalReleasePolicyService({
    currentVersion: TETI_BUILD_INFO.appVersion,
    buildTimestamp: TETI_BUILD_INFO.buildTimestamp,
    store: new FileReleasePolicyStore(join(profile.storeDir, "network-release-policy-v1.json")),
    client: new NetworkBootstrapReleasePolicyClient(networkClient)
  });
  await releasePolicyService.initialize();
  const codexUsageService = getDefaultCodexUsageService();
  const agentConfigPath = join(profile.storeDir, "agent-detectors.override.json");
  const agentConfiguration = new FileAgentDetectorConfiguration(agentConfigPath);
  const agentObserver = new AgentObserverSupervisor({
    loadCatalog: () => loadAgentDetectorCatalog({
      path: agentConfigPath
    }),
    system: createMacAgentObserverSystem()
  });
  const taskAttachmentStore = new FileTaskAttachmentStore(join(profile.storeDir, "task-attachments"));
  const workspaceStore = new FileCollaborationWorkspaceStore(
    join(profile.storeDir, "collaboration-workspaces")
  );
  await workspaceStore.initialize();
  const executionRegistry = new DurableExecutionRegistry({
    store: new FileExecutionHandleStore(join(profile.storeDir, "execution-handles.json")),
    checkpointRoot: join(profile.storeDir, "execution-checkpoints")
  });
  const memoryService = new ChildMemoryService({
    store: new FileChildMemoryStore(join(profile.storeDir, "child-memory-v1.json")),
    exportRoot: join(profile.storeDir, "memory-exports")
  });
  const osaurusTrustVerifier = new OsaurusRuntimeIdentityVerifier();
  const osaurusNativeAuditor = new FileOsaurusNativeAgentPolicyAuditor();
  const osaurusNativeConfigPath = join(profile.storeDir, "osaurus-native-child.json");
  let osaurusNativeReadiness: {
    state: "unconfigured" | "checking" | "ready" | "blocked";
    reasonCode?: string;
  } = { state: "unconfigured" };
  const hostAgent = new TetiHostAgentKernel({
    artifactImageStore: taskAttachmentStore,
    workspaceStore,
    executionRegistry,
    memoryProvider: memoryService,
    onCollaborationActiveChange: (active) => runtime?.setPresenceCollaborationActive(active),
    transports: [
      new ProcessTransport(),
      new LoopbackHttpTransport({ identityVerifier: osaurusTrustVerifier }),
      new OsaurusAgentTransport({
        identityVerifier: osaurusTrustVerifier,
        authorityVerifier: osaurusNativeAuditor
      })
    ]
  });
  const networkProfileService = new TetiNetworkProfileService({
    client: networkClient,
    store: new FileTetiNetworkProfileSyncStore(networkStatePaths.profileSyncPath),
    getAuthentication: getNetworkAuthentication,
    getDesiredProfile: async () => {
      const account = await accountStorage.load();
      if (!account) throw new Error("A local Teti account is required before Network Profile sync.");
      return projectNetworkPublicProfile(account, hostAgent.getCallableAgents());
    }
  });
  const networkRelationshipService = new TetiNetworkRelationshipService({
    client: networkClient,
    store: new FileTetiNetworkRelationshipCommandStore(networkStatePaths.relationshipCommandPath),
    reconciliationStore: new FileTetiNetworkRelationshipReconciliationStore(
      networkStatePaths.relationshipReconciliationPath
    ),
    getAuthentication: getNetworkAuthentication
  });
  const codexImageRunnerPath = join(dirname(fileURLToPath(import.meta.url)), "codex-image-runner.mjs");
  let pathOverridesPromise: Promise<Record<string, string>> | undefined;
  const loadPathOverrides = () => {
    pathOverridesPromise ??= agentConfiguration.getPathOverrides().catch(() => ({}));
    return pathOverridesPromise;
  };
  const qualificationSupervisor = new CallableQualificationSupervisor({
    jobs: [
      async (signal) => {
        const pathOverrides = await loadPathOverrides();
        if (signal.aborted) return;
        const qualification = await qualifyCodexConnector({
          pathOverride: pathOverrides.codex,
          signal
        });
        if (signal.aborted) return;
        writeRuntimeDiagnostic("callable.codex", {
          state: qualification.readiness.state,
          code: qualification.readiness.reasonCode,
          adapterRevision: qualification.readiness.adapterRevision
        });
        if (qualification.connector) {
          hostAgent.registerConnector(
            qualification.connector,
            qualification.readiness.checkedAt
          );
          hostAgent.registerConnector(
            new CodexImageConnector({
              nodeEntrypoint: process.execPath,
              runnerPath: codexImageRunnerPath,
              codexEntrypoint: qualification.connector.fixedProcessEntrypoint,
              ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {})
            }),
            qualification.readiness.checkedAt
          );
          runtime?.notifyNetworkProfileStateChange("capability", publicCapabilityIds(hostAgent));
        }
      },
      async (signal) => {
        const pathOverrides = await loadPathOverrides();
        if (signal.aborted) return;
        const qualification = await qualifyCodeBuddyConnector({
          pathOverride: pathOverrides.codebuddy,
          signal
        });
        if (signal.aborted) return;
        writeRuntimeDiagnostic("callable.codebuddy", {
          state: qualification.readiness.state,
          code: qualification.readiness.reasonCode,
          adapterRevision: qualification.readiness.adapterRevision,
          desktopDetected: qualification.evidence.desktopDetected,
          officialCliDetected: qualification.evidence.officialCliDetected
        });
        if (qualification.connector) {
          hostAgent.registerConnector(
            qualification.connector,
            qualification.readiness.checkedAt
          );
          runtime?.notifyNetworkProfileStateChange("capability", publicCapabilityIds(hostAgent));
        }
      },
      async (signal) => {
        while (!signal.aborted) {
          const qualification = await qualifyOsaurusConnector({
            signal,
            trustVerifier: osaurusTrustVerifier
          });
          if (signal.aborted) return;
          writeRuntimeDiagnostic("callable.osaurus-runtime", {
            state: qualification.readiness.state,
            code: qualification.readiness.reasonCode,
            adapterRevision: qualification.readiness.adapterRevision,
            origin: "runtime_facade",
            releaseBlockers: qualification.releaseBlockers.join(",") || undefined
          });
          if (qualification.connector) {
            hostAgent.registerConnector(
              qualification.connector,
              qualification.readiness.checkedAt
            );
            runtime?.notifyNetworkProfileStateChange("capability", publicCapabilityIds(hostAgent));
            return;
          }
          await waitForRetry(signal, OSAURUS_QUALIFICATION_RETRY_MS);
        }
      },
      async (signal) => {
        let registeredDigest: string | null = null;
        while (!signal.aborted) {
          let configuration = null;
          try {
            configuration = await readOsaurusNativeChildConfiguration(
              osaurusNativeConfigPath,
              process.env.TETI_OSAURUS_NATIVE_AGENT_ID
            );
          } catch {
            // Qualification below turns malformed local configuration into a
            // stable, privacy-safe diagnostic without exposing its contents.
          }
          const qualification = await qualifyOsaurusNativeConnector({
            agentId: configuration?.agentId,
            signal,
            trustVerifier: osaurusTrustVerifier,
            policyAuditor: osaurusNativeAuditor
          });
          if (signal.aborted) return;
          osaurusNativeReadiness = {
            state: !configuration?.agentId
              ? "unconfigured"
              : qualification.connector
                ? "ready"
                : isNativeAuthorityBlocker(qualification.readiness.reasonCode)
                  ? "blocked"
                  : "checking",
            ...(qualification.readiness.reasonCode
              ? { reasonCode: qualification.readiness.reasonCode }
              : {})
          };
          const nextDigest = qualification.audit?.configurationDigest ?? null;
          if (registeredDigest && (!qualification.connector || nextDigest !== registeredDigest)) {
            hostAgent.unregisterConnector(OSAURUS_NATIVE_CHILD.connectorId);
            registeredDigest = null;
            runtime?.notifyNetworkProfileStateChange("capability", publicCapabilityIds(hostAgent));
          }
          if (!registeredDigest && qualification.connector && nextDigest) {
            hostAgent.registerConnector(qualification.connector, qualification.readiness.checkedAt);
            registeredDigest = nextDigest;
            runtime?.notifyNetworkProfileStateChange("capability", publicCapabilityIds(hostAgent));
          }
          writeRuntimeDiagnostic("callable.osaurus-native", {
            state: qualification.readiness.state,
            code: qualification.readiness.reasonCode,
            adapterRevision: qualification.readiness.adapterRevision,
            origin: "native_agent",
            workspacePolicy: "bounded_context",
            releaseBlockers: qualification.releaseBlockers.join(",") || undefined,
            acceptedRisks: qualification.acceptedRisks.join(",") || undefined
          });
          await waitForNativeAgentChange(signal, [
            { directory: profile.storeDir, fileName: "osaurus-native-child.json" },
            { directory: osaurusNativeAuditor.agentsRoot }
          ], OSAURUS_QUALIFICATION_RETRY_MS);
        }
      }
    ],
    onJobError: ({ index, error }) => {
      writeRuntimeDiagnostic("callable.qualification", {
        state: "failed",
        job: index === 0
          ? "codex"
          : index === 1
            ? "codebuddy"
            : index === 2
              ? "osaurus-runtime"
              : "osaurus-native",
        message: redactSecretLikeText(error instanceof Error ? error.message : String(error))
      });
    }
  });
  runtime = new TetiRuntime({
    dependencies: {
      networkClient,
      loadTetiAccount: defaultLifecycleSidecarDependencies.loadTetiAccount,
      synchronizeNetworkIdentity,
      synchronizeNetworkRelayBinding: () => networkRelayService.synchronize().then(() => undefined),
      getPeerConnectionService: () => getDefaultPeerConnectionService({
        directory: new TetiNetworkPublicReadAdapter(networkClient),
        getLocalCallableAgents: () => hostAgent.getCallableAgents(),
        getLocalComputeOffers: () => hostAgent.getComputeOffers(),
        taskExecutor: hostAgent,
        taskAttachmentStore,
        workspaceStore,
        relationshipService: networkRelationshipService
      }),
      passportSharingStore: await getDefaultPassportSharingStore(),
      codexUsageService,
      agentObserver,
      agentConfiguration,
      hostAgent,
      memoryService,
      releasePolicyService,
      presenceController,
      profileService: networkProfileService,
      dispose: async () => {
        await qualificationSupervisor.stop();
        await closeDefaultPeerConnectionService();
      }
    },
    onJobError: ({ jobId, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      writeRuntimeDiagnostic("runtime.job", {
        job: jobId,
        result: "failed",
        code: readErrorCode(error),
        message: redactSecretLikeText(message)
      });
    },
    onNetworkIdentityStatusChange: ({ status, attempt, nextRetryMs }) => {
      writeRuntimeDiagnostic("network.identity", {
        state: status.state,
        code: status.errorCode,
        retryable: status.retryable,
        attempt,
        nextRetryMs
      });
    },
    onNetworkStatusChange: (status) => {
      writeRuntimeDiagnostic("network.contract", {
        state: status.state,
        code: "errorCode" in status ? status.errorCode : undefined,
        protocolVersion: "protocolVersion" in status ? status.protocolVersion : undefined,
        contractRevision: "contractRevision" in status ? status.contractRevision : undefined,
        serviceVersion: "serviceVersion" in status ? status.serviceVersion : undefined,
        retryable: "retryable" in status ? status.retryable : undefined,
        requestId: "requestId" in status ? status.requestId : undefined
      });
    },
    onStateChange: (event) => {
      writeRuntimeDiagnostic("runtime.state-change", {
        kind: event.kind,
        observedAt: event.observedAt
      });
    }
  });
  lifecycleDependencies = createRuntimeOwnedLifecycleDependencies(
    {
      ...defaultLifecycleSidecarDependencies,
      createTetiAccount: (input) => createGuardedRealTetiAccount(input, {
        resolveAccountProvisioning: () => networkRelayService.selectProvisioningRelay()
      }),
      getOsaurusNativeChildSettings: async () => {
        const configuration = await readOsaurusNativeChildConfiguration(
          osaurusNativeConfigPath,
          process.env.TETI_OSAURUS_NATIVE_AGENT_ID
        ) ?? { schemaVersion: 1 as const, agentId: null };
        return {
          ...configuration,
          readiness: configuration.agentId ? osaurusNativeReadiness.state : "unconfigured",
          ...(configuration.agentId && osaurusNativeReadiness.reasonCode
            ? { reasonCode: osaurusNativeReadiness.reasonCode }
            : {})
        };
      },
      setOsaurusNativeChildAgentId: async (agentId) => {
        if (process.env.TETI_OSAURUS_NATIVE_AGENT_ID?.trim()) {
          throw new Error("Osaurus Native Agent ID is managed by the launch environment.");
        }
        const configuration = await writeOsaurusNativeChildConfiguration(osaurusNativeConfigPath, agentId);
        osaurusNativeReadiness = { state: configuration.agentId ? "checking" : "unconfigured" };
        return { ...configuration, readiness: osaurusNativeReadiness.state };
      },
      getNetworkEnvironmentSettings: () => networkEnvironmentSettings.settings,
      setLocalDevelopmentNetwork: (enabled) =>
        networkEnvironmentSettings.setUseLocalDevelopmentNetwork(enabled)
    },
    runtime
  );

  const reader = createInterface({
    input: stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  reader.on("line", (line) => { void handleLine(line); });
  reader.once("close", () => { void beginShutdown(0); });
  runtime.start();
  qualificationSupervisor.start();
}

function resolveNetworkAdoptionGrant(baseUrl: string): string | undefined {
  const configured = process.env[TETI_NETWORK_ADOPTION_GRANT];
  if (configured) return configured;
  const host = new URL(baseUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1"
    ? DEVELOPMENT_FIRST_CLAIM_ADOPTION_GRANT
    : undefined;
}

function publicCapabilityIds(hostAgent: TetiHostAgentKernel): string[] {
  return [...new Set(hostAgent.getCallableAgents().flatMap((agent) => agent.capabilityIds))].sort();
}

function isNativeAuthorityBlocker(reasonCode: string | undefined): boolean {
  return reasonCode === "OSAURUS_NATIVE_AGENT_ID_INVALID"
    || reasonCode === "OSAURUS_NATIVE_AUTHORITY_UNSAFE"
    || reasonCode === "OSAURUS_NATIVE_METADATA_MISMATCH"
    || reasonCode === "OSAURUS_RUNTIME_UNTRUSTED"
    || reasonCode === "OSAURUS_RUNTIME_LISTENER_MISMATCH"
    || reasonCode === "OSAURUS_RUNTIME_EXECUTABLE_UNTRUSTED"
    || reasonCode === "OSAURUS_RUNTIME_APP_PATH_UNTRUSTED"
    || reasonCode === "OSAURUS_RUNTIME_SIGNATURE_INVALID"
    || reasonCode === "OSAURUS_RUNTIME_SIGNATURE_MISMATCH"
    || reasonCode === "OSAURUS_RUNTIME_VERSION_UNSUPPORTED"
    || reasonCode === "OSAURUS_INSIGHTS_POLICY_UNVERIFIED";
}

function waitForRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function waitForNativeAgentChange(
  signal: AbortSignal,
  targets: readonly { directory: string; fileName?: string }[],
  fallbackMs: number
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const watchers: ReturnType<typeof watch>[] = [];
    const timer = setTimeout(finish, fallbackMs);
    for (const target of targets) {
      try {
        watchers.push(watch(target.directory, (_event, fileName) => {
          if (target.fileName && fileName?.toString() !== target.fileName) return;
          finish();
        }));
      } catch {
        // A missing Osaurus directory is expected before first launch; the
        // bounded retry remains active and discovers it later.
      }
    }
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function handleLine(line: string): Promise<void> {
  if (!lifecycleDependencies || shutdownPromise) return;
  const id = readLineId(line);
  if (id && inFlightRequestIds.has(id)) {
    writeResponse({
      version: LIFECYCLE_PROTOCOL_VERSION,
      id,
      ok: false,
      error: createLifecycleError("DUPLICATE_REQUEST", "Lifecycle request id is already in flight.", {
        recoverable: false
      })
    });
    return;
  }

  if (id) {
    inFlightRequestIds.add(id);
  }

  try {
    writeResponse(await handleLifecycleLine(line, lifecycleDependencies));
  } finally {
    if (id) {
      inFlightRequestIds.delete(id);
    }
  }
}

function writeResponse(response: LifecycleResponse): void {
  if (!safeStdout.write(`${JSON.stringify(response)}\n`)) {
    void beginShutdown(0);
  }
}

function readLineId(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

function beginShutdown(exitCode: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const hardExit = setTimeout(() => process.exit(exitCode), PROCESS_SHUTDOWN_HARD_LIMIT_MS);
    const result = await runtime?.stop();
    if (result?.timedOut) {
      safeStderr.write("teti-runtime shutdown reached its bounded timeout.\n");
    }
    await profileLock?.release().catch(() => undefined);
    clearTimeout(hardExit);
    process.exit(exitCode);
  })();
  return shutdownPromise;
}
