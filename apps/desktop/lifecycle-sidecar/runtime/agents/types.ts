import type {
  AgentObservationSnapshot,
  AgentSurface,
  ObservationSafeError
} from "../../../../../core/observation/types.ts";
import type { AiAgent } from "../../../../../core/passport/types.ts";

export type AgentInstallDetector =
  | {
      type: "executable";
      names: string[];
    }
  | {
      type: "executable_path";
      paths: string[];
      expectedNames: string[];
    }
  | {
      type: "app_bundle";
      paths: string[];
      bundleIdentifiers: string[];
      readVersion: boolean;
    };

export interface AgentProcessDetector {
  type: "exact_name";
  names: string[];
}

export interface AgentVersionProbe {
  type: "fixed_args";
  args: ["--version"] | ["-V"] | ["version"];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface AgentDetectorCapabilities {
  installation: true;
  version: boolean;
  runtime: boolean;
  activity: false;
  entitlement: false;
  quota: false;
}

export interface AgentDetectorPrivacy {
  collectPaths: false;
  collectCommands: false;
  collectContent: false;
  networkAllowed: false;
  shareByDefault: false;
}

export interface AgentDetectorDefinition {
  schemaVersion: 1;
  id: string;
  provider: string;
  displayName: string;
  enabled: boolean;
  surfaces: AgentSurface[];
  installDetectors: AgentInstallDetector[];
  processDetectors: AgentProcessDetector[];
  versionProbe?: AgentVersionProbe;
  capabilities: AgentDetectorCapabilities;
  privacy: AgentDetectorPrivacy;
  source: "builtin" | "user";
  revision: number;
}

export interface AgentDetectorCatalog {
  schemaVersion: 1;
  discoveryEnabled: boolean;
  customDetectorsEnabled: boolean;
  definitions: AgentDetectorDefinition[];
  errors: ObservationSafeError[];
}

export interface ResolvedExecutable {
  canonicalPath: string;
}

export interface AppBundleInspection {
  present: boolean;
  version?: string;
}

export interface AgentObserverSystem {
  findExecutable(names: readonly string[]): Promise<ResolvedExecutable | null>;
  findExecutablePath(
    paths: readonly string[],
    expectedNames: readonly string[]
  ): Promise<ResolvedExecutable | null>;
  inspectAppBundle(
    paths: readonly string[],
    bundleIdentifiers: readonly string[],
    readVersion: boolean
  ): Promise<AppBundleInspection>;
  listProcessNames(): Promise<string[]>;
  runVersionProbe(
    executablePath: string,
    probe: AgentVersionProbe
  ): Promise<string | null>;
}

export interface RuntimeAgentObserver {
  discover(): Promise<AgentObservationSnapshot>;
  getCurrentSnapshot(): AgentObservationSnapshot;
  getPassportAgents(): AiAgent[];
}

export interface RuntimeAgentConfiguration {
  getPathOverrides(): Promise<Record<string, string>>;
  setPathOverride(agentId: string, path: string | null): Promise<void>;
}
