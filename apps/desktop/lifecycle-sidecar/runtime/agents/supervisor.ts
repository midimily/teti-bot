import type {
  AgentObservation,
  AgentObservationSnapshot,
  ObservationConfidence,
  ObservationEvidence,
  ObservationSafeError,
  ObservationSource
} from "../../../../../core/observation/types.ts";
import { assertPrivacySafeObservation } from "../../../../../core/observation/privacy.ts";
import type {
  AiAgent,
  AiAgentDetectionSource,
  AiAgentType
} from "../../../../../core/passport/types.ts";
import type {
  AgentDetectorCatalog,
  AgentDetectorDefinition,
  AgentObserverSystem,
  RuntimeAgentObserver
} from "./types.ts";

const DEFAULT_AGENT_DETECTOR_TIMEOUT_MS = 3_000;

export interface AgentObserverSupervisorOptions {
  loadCatalog(): Promise<AgentDetectorCatalog>;
  system: AgentObserverSystem;
  now?: () => Date;
  detectorTimeoutMs?: number;
}

export class AgentObserverSupervisor implements RuntimeAgentObserver {
  private readonly loadCatalog: () => Promise<AgentDetectorCatalog>;
  private readonly system: AgentObserverSystem;
  private readonly now: () => Date;
  private readonly detectorTimeoutMs: number;
  private snapshotValue: AgentObservationSnapshot;
  private discovery?: Promise<AgentObservationSnapshot>;
  private completedOnce = false;
  private readonly lastRunningAt = new Map<string, string>();

  constructor(options: AgentObserverSupervisorOptions) {
    this.loadCatalog = options.loadCatalog;
    this.system = options.system;
    this.now = options.now ?? (() => new Date());
    this.detectorTimeoutMs = options.detectorTimeoutMs ?? DEFAULT_AGENT_DETECTOR_TIMEOUT_MS;
    if (!Number.isFinite(this.detectorTimeoutMs) || this.detectorTimeoutMs <= 0) {
      throw new Error("Agent detector timeout must be positive.");
    }
    const generatedAt = this.now().toISOString();
    this.snapshotValue = {
      schemaVersion: 1,
      revision: 0,
      state: "idle",
      generatedAt,
      agents: [],
      errors: []
    };
  }

  discover(): Promise<AgentObservationSnapshot> {
    if (this.discovery) return this.discovery;
    const startedAt = this.now().toISOString();
    this.snapshotValue = {
      ...this.snapshotValue,
      state: "discovering",
      generatedAt: startedAt,
      startedAt,
      agents: this.completedOnce ? this.snapshotValue.agents : [],
      errors: []
    };
    const operation = this.runDiscovery(startedAt);
    this.discovery = operation;
    const clear = () => {
      if (this.discovery === operation) this.discovery = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  getCurrentSnapshot(): AgentObservationSnapshot {
    return structuredClone(this.snapshotValue);
  }

  getPassportAgents(): AiAgent[] {
    if (!this.completedOnce) return [];
    return this.snapshotValue.agents.map(toPassportAgent);
  }

  private async runDiscovery(startedAt: string): Promise<AgentObservationSnapshot> {
    let catalog: AgentDetectorCatalog;
    try {
      catalog = await this.loadCatalog();
    } catch {
      catalog = {
        schemaVersion: 1,
        discoveryEnabled: true,
        customDetectorsEnabled: false,
        definitions: [],
        errors: [safeError("AGENT_CONFIG_LOAD_FAILED")]
      };
    }

    if (!catalog.discoveryEnabled) {
      return this.complete("disabled", [], catalog.errors, startedAt);
    }

    let processNames: string[] | null = null;
    const snapshotErrors = [...catalog.errors];
    try {
      processNames = await this.system.listProcessNames();
    } catch {
      snapshotErrors.push(safeError("PROCESS_ENUMERATION_FAILED"));
    }

    const observations = await Promise.all(catalog.definitions.map(async (definition) => {
      try {
        return await withTimeout(
          this.observeDefinition(definition, processNames),
          this.detectorTimeoutMs,
          () => unknownObservation(definition, this.now().toISOString(), "AGENT_DETECTOR_TIMEOUT")
        );
      } catch (error) {
        return unknownObservation(
          definition,
          this.now().toISOString(),
          safeCode(error, "AGENT_DETECTOR_FAILED")
        );
      }
    }));

    for (const observation of observations) assertPrivacySafeObservation(observation);
    const hasErrors = snapshotErrors.length > 0 || observations.some((observation) => observation.errors.length > 0);
    return this.complete(hasErrors ? "degraded" : "ready", observations, snapshotErrors, startedAt);
  }

  private async observeDefinition(
    definition: AgentDetectorDefinition,
    processNames: readonly string[] | null
  ): Promise<AgentObservation> {
    const observedAt = this.now().toISOString();
    const installationEvidence: ObservationEvidence[] = [];
    const errors: ObservationSafeError[] = [];
    let executablePath: string | null = null;
    let appVersion: string | null = null;
    let positiveInstallSignal = false;
    let completedInstallChecks = 0;

    for (const detector of definition.installDetectors) {
      try {
        if (detector.type === "executable") {
          const executable = await this.system.findExecutable(detector.names);
          completedInstallChecks += 1;
          if (executable) {
            executablePath ??= executable.canonicalPath;
            positiveInstallSignal = true;
            installationEvidence.push(evidence(definition, "executable", "high", observedAt));
          }
        } else if (detector.type === "executable_path") {
          const executable = await this.system.findExecutablePath(
            detector.paths,
            detector.expectedNames
          );
          completedInstallChecks += 1;
          if (executable) {
            executablePath ??= executable.canonicalPath;
            positiveInstallSignal = true;
            installationEvidence.push(evidence(definition, "executable", "high", observedAt));
          }
        } else {
          const app = await this.system.inspectAppBundle(
            detector.paths,
            detector.bundleIdentifiers,
            detector.readVersion
          );
          completedInstallChecks += 1;
          if (app.present) {
            positiveInstallSignal = true;
            appVersion ??= app.version ?? null;
            installationEvidence.push(evidence(definition, "app_bundle", "high", observedAt));
          }
        }
      } catch (error) {
        errors.push(safeError(safeCode(error, "AGENT_INSTALL_DETECTOR_FAILED")));
      }
    }

    const processCount = processNames === null
      ? null
      : countMatchingProcesses(processNames, definition);
    if ((processCount ?? 0) > 0) {
      positiveInstallSignal = true;
      installationEvidence.push(evidence(definition, "process", "medium", observedAt));
      this.lastRunningAt.set(definition.id, observedAt);
    }

    let version = appVersion;
    if (!version && executablePath && definition.versionProbe && definition.capabilities.version) {
      try {
        version = await this.system.runVersionProbe(executablePath, definition.versionProbe);
      } catch (error) {
        errors.push(safeError(safeCode(error, "VERSION_PROBE_FAILED")));
      }
    }

    const installationState = positiveInstallSignal
      ? "installed"
      : completedInstallChecks > 0
        ? "not_installed"
        : "unknown";
    const runtimeState = processNames === null
      ? "unknown"
      : (processCount ?? 0) > 0
        ? "running"
        : "not_running";
    const runtimeEvidence = processNames === null
      ? []
      : [evidence(definition, "process", "medium", observedAt)];
    const lastSeenAt = this.lastRunningAt.get(definition.id);

    return {
      schemaVersion: 1,
      observationId: `${definition.id}:${observedAt}`,
      agentId: definition.id,
      provider: definition.provider,
      displayName: definition.displayName,
      surfaces: [...definition.surfaces],
      supportedLevels: [1, 2],
      installation: {
        state: installationState,
        ...(version ? { version } : {}),
        evidence: installationEvidence
      },
      runtime: {
        state: runtimeState,
        ...(processCount === null ? {} : { processCount }),
        ...(lastSeenAt ? { lastSeenAt } : {}),
        evidence: runtimeEvidence
      },
      observedAt,
      errors
    };
  }

  private complete(
    state: "ready" | "degraded" | "disabled",
    agents: AgentObservation[],
    errors: ObservationSafeError[],
    startedAt: string
  ): AgentObservationSnapshot {
    const completedAt = this.now().toISOString();
    this.completedOnce = true;
    this.snapshotValue = {
      schemaVersion: 1,
      revision: this.snapshotValue.revision + 1,
      state,
      generatedAt: completedAt,
      startedAt,
      completedAt,
      agents: structuredClone(agents),
      errors: structuredClone(errors)
    };
    return this.getCurrentSnapshot();
  }
}

function toPassportAgent(observation: AgentObservation): AiAgent {
  const source = observation.installation?.evidence[0]?.source;
  const confidence = strongestConfidence([
    ...(observation.installation?.evidence ?? []),
    ...(observation.runtime?.evidence ?? [])
  ]);
  return {
    id: observation.agentId,
    name: observation.displayName,
    provider: observation.provider,
    type: toPassportSurface(observation.surfaces[0] ?? "local_service"),
    surfaces: observation.surfaces.map(toPassportSurface),
    installationStatus: observation.installation?.state ?? "unknown",
    ...(source ? { detectionSource: toPassportDetectionSource(source) } : {}),
    ...(observation.installation?.version ? { version: observation.installation.version } : {}),
    ...(observation.runtime ? { runtimeStatus: observation.runtime.state } : {}),
    ...(observation.runtime?.processCount === undefined
      ? {}
      : { processCount: observation.runtime.processCount }),
    ...(confidence ? { confidence } : {}),
    ...(observation.runtime?.lastSeenAt ? { lastSeenAt: observation.runtime.lastSeenAt } : {}),
    observedAt: observation.observedAt
  };
}

function toPassportSurface(surface: AgentObservation["surfaces"][number]): AiAgentType {
  return surface;
}

function toPassportDetectionSource(source: ObservationSource): AiAgentDetectionSource {
  if (source === "app_bundle") return "application";
  if (source === "process") return "process";
  return "command";
}

function countMatchingProcesses(
  processNames: readonly string[],
  definition: AgentDetectorDefinition
): number {
  const accepted = new Set(
    definition.processDetectors.flatMap((detector) => detector.names.map((name) => name.toLowerCase()))
  );
  if (accepted.size === 0) return 0;
  return processNames.reduce(
    (count, name) => count + (accepted.has(name.toLowerCase()) ? 1 : 0),
    0
  );
}

function evidence(
  definition: AgentDetectorDefinition,
  source: ObservationSource,
  confidence: ObservationConfidence,
  observedAt: string
): ObservationEvidence {
  return {
    source,
    confidence,
    assurance: source === "process" ? "inferred" : "locally_observed",
    adapterId: `${definition.source}.${definition.id}`,
    adapterRevision: definition.revision,
    observedAt
  };
}

function unknownObservation(
  definition: AgentDetectorDefinition,
  observedAt: string,
  code: string
): AgentObservation {
  return {
    schemaVersion: 1,
    observationId: `${definition.id}:${observedAt}`,
    agentId: definition.id,
    provider: definition.provider,
    displayName: definition.displayName,
    surfaces: [...definition.surfaces],
    supportedLevels: [1, 2],
    installation: { state: "unknown", evidence: [] },
    runtime: { state: "unknown", evidence: [] },
    observedAt,
    errors: [safeError(code)]
  };
}

function strongestConfidence(evidenceValues: readonly ObservationEvidence[]): ObservationConfidence | undefined {
  if (evidenceValues.some((item) => item.confidence === "high")) return "high";
  if (evidenceValues.some((item) => item.confidence === "medium")) return "medium";
  if (evidenceValues.some((item) => item.confidence === "low")) return "low";
  return undefined;
}

function safeError(code: string): ObservationSafeError {
  return { code, recoverable: true };
}

function safeCode(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : fallback;
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  fallback: () => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback());
    }, timeoutMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
