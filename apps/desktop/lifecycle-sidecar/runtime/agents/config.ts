import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { AgentSurface, ObservationSafeError } from "../../../../../core/observation/types.ts";
import { BUILTIN_AGENT_DETECTORS, cloneBuiltinAgentDetectors } from "./defaults.ts";
import type {
  AgentDetectorCatalog,
  AgentDetectorDefinition,
  AgentDetectorPrivacy,
  AgentInstallDetector,
  AgentProcessDetector,
  RuntimeAgentConfiguration
} from "./types.ts";

const MAX_CUSTOM_AGENTS = 32;
const MAX_AGENT_CONFIG_ENTRIES = 64;
const MAX_DETECTORS_PER_AGENT = 8;
const MAX_VALUES_PER_DETECTOR = 8;
const ID_PATTERN = /^user\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const PROVIDER_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const PROCESS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,95}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const APP_PATH_PATTERN = /^(?:\/Applications|~\/Applications)\/[A-Za-z0-9][A-Za-z0-9 ._+-]{0,95}\.app$/;
const SURFACES = new Set<AgentSurface>(["cli", "desktop", "ide_extension", "local_service"]);
export const TETI_AGENT_DISCOVERY_DISABLED = "TETI_AGENT_DISCOVERY_DISABLED";

export interface AgentDetectorConfigLoaderOptions {
  path: string;
  readText?: (path: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

export async function loadAgentDetectorCatalog(
  options: AgentDetectorConfigLoaderOptions
): Promise<AgentDetectorCatalog> {
  if ((options.env ?? process.env)[TETI_AGENT_DISCOVERY_DISABLED] === "1") {
    return {
      schemaVersion: 1,
      discoveryEnabled: false,
      customDetectorsEnabled: false,
      definitions: [],
      errors: []
    };
  }
  const builtins = cloneBuiltinAgentDetectors();
  let text: string;
  try {
    text = await (options.readText ?? readUtf8)(options.path);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return catalog(builtins);
    return catalog(builtins, [safeError("AGENT_CONFIG_READ_FAILED")]);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return catalog(builtins, [safeError("AGENT_CONFIG_INVALID_JSON")]);
  }

  const root = record(value);
  if (!root || !exactKeys(root, [
    "schemaVersion",
    "discoveryEnabled",
    "customDetectorsEnabled",
    "agents"
  ]) || root.schemaVersion !== 1) {
    return catalog(builtins, [safeError("AGENT_CONFIG_SCHEMA_MISMATCH")]);
  }

  const discoveryEnabled = optionalBoolean(root.discoveryEnabled, true);
  const customDetectorsEnabled = optionalBoolean(root.customDetectorsEnabled, true);
  if (discoveryEnabled === null || customDetectorsEnabled === null) {
    return catalog(builtins, [safeError("AGENT_CONFIG_SCHEMA_MISMATCH")]);
  }
  if (root.agents !== undefined && (!Array.isArray(root.agents) || root.agents.length > MAX_AGENT_CONFIG_ENTRIES)) {
    return catalog(builtins, [safeError("AGENT_CONFIG_SCHEMA_MISMATCH")]);
  }

  const definitions = new Map(builtins.map((definition) => [definition.id, definition]));
  const builtinIds = new Set(definitions.keys());
  const seen = new Set<string>();
  const errors: ObservationSafeError[] = [];
  let customAgentsSeen = 0;

  for (const entry of root.agents ?? []) {
    const candidate = record(entry);
    const id = candidate && typeof candidate.id === "string" ? candidate.id : null;
    if (!id) {
      errors.push(safeError("AGENT_CONFIG_ENTRY_INVALID"));
      continue;
    }
    if (seen.has(id)) {
      errors.push(safeError("AGENT_CONFIG_DUPLICATE_ID"));
      continue;
    }
    seen.add(id);

    if (builtinIds.has(id)) {
      const definition = definitions.get(id)!;
      const enabled = optionalBoolean(candidate!.enabled, true);
      const pathOverride = candidate!.pathOverride === undefined
        ? undefined
        : validateBuiltinPathOverride(definition, candidate!.pathOverride);
      if (
        !exactKeys(candidate!, ["id", "enabled", "pathOverride"])
        || enabled === null
        || pathOverride === null
      ) {
        errors.push(safeError("AGENT_CONFIG_BUILTIN_OVERRIDE_INVALID"));
        continue;
      }
      if (!enabled) {
        definitions.delete(id);
      } else if (pathOverride) {
        definitions.set(id, applyBuiltinPathOverride(definition, pathOverride));
      }
      continue;
    }

    customAgentsSeen += 1;
    if (customAgentsSeen > MAX_CUSTOM_AGENTS) {
      errors.push(safeError("AGENT_CONFIG_ENTRY_LIMIT"));
      continue;
    }
    const custom = validateCustomDefinition(candidate!);
    if (!custom.ok) {
      errors.push(safeError(custom.code));
      continue;
    }
    if (customDetectorsEnabled && custom.definition.enabled) {
      definitions.set(custom.definition.id, custom.definition);
    }
  }

  return {
    schemaVersion: 1,
    discoveryEnabled,
    customDetectorsEnabled,
    definitions: discoveryEnabled ? [...definitions.values()] : [],
    errors
  };
}

export class FileAgentDetectorConfiguration implements RuntimeAgentConfiguration {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async getPathOverrides(): Promise<Record<string, string>> {
    const root = await readConfigRootForMutation(this.path);
    const result: Record<string, string> = {};
    for (const entry of root.agents ?? []) {
      const candidate = record(entry);
      if (!candidate || typeof candidate.id !== "string" || typeof candidate.pathOverride !== "string") continue;
      const definition = BUILTIN_AGENT_DETECTORS.find((item) => item.id === candidate.id);
      const pathOverride = definition
        ? validateBuiltinPathOverride(definition, candidate.pathOverride)
        : null;
      if (pathOverride) result[definition!.id] = pathOverride;
    }
    return result;
  }

  async setPathOverride(agentId: string, path: string | null): Promise<void> {
    const definition = BUILTIN_AGENT_DETECTORS.find((item) => item.id === agentId);
    if (!definition) throw new AgentDetectorConfigurationError("AGENT_OVERRIDE_UNKNOWN_AGENT");
    const pathOverride = path === null ? null : validateBuiltinPathOverride(definition, path);
    if (path !== null && pathOverride === null) {
      throw new AgentDetectorConfigurationError("AGENT_OVERRIDE_PATH_INVALID");
    }

    const root = await readConfigRootForMutation(this.path);
    const agents = [...(root.agents ?? [])];
    const index = agents.findIndex((entry) => record(entry)?.id === agentId);
    const existing = index >= 0 ? record(agents[index]) : null;
    if (existing && (
      !exactKeys(existing, ["id", "enabled", "pathOverride"])
      || optionalBoolean(existing.enabled, true) === null
    )) {
      throw new AgentDetectorConfigurationError("AGENT_CONFIG_WRITE_BLOCKED");
    }

    if (pathOverride) {
      const next = {
        id: agentId,
        enabled: existing?.enabled ?? true,
        pathOverride
      };
      if (index >= 0) agents[index] = next;
      else agents.push(next);
    } else if (index >= 0) {
      if (existing?.enabled === false) agents[index] = { id: agentId, enabled: false };
      else agents.splice(index, 1);
    }

    if (agents.length > MAX_AGENT_CONFIG_ENTRIES) {
      throw new AgentDetectorConfigurationError("AGENT_CONFIG_WRITE_BLOCKED");
    }
    await writeConfigAtomically(this.path, { ...root, agents });
  }
}

export class AgentDetectorConfigurationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AgentDetectorConfigurationError";
    this.code = code;
  }
}

type CustomValidation =
  | { ok: true; definition: AgentDetectorDefinition }
  | { ok: false; code: string };

function validateCustomDefinition(value: Record<string, unknown>): CustomValidation {
  if (!exactKeys(value, [
    "schemaVersion",
    "id",
    "provider",
    "displayName",
    "enabled",
    "surfaces",
    "installDetectors",
    "processDetectors",
    "capabilities",
    "privacy",
    "source",
    "revision"
  ])) return invalid();
  if (value.schemaVersion !== 1 || value.source !== "user") return invalid();
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id) || value.id.length > 64) return invalid();
  if (typeof value.provider !== "string" || !PROVIDER_PATTERN.test(value.provider) || value.provider.length > 64) {
    return invalid();
  }
  if (typeof value.displayName !== "string" || !isSafeDisplayName(value.displayName)) return invalid();
  if (typeof value.enabled !== "boolean") return invalid();
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1) return invalid();

  const surfaces = stringArray(value.surfaces, 4);
  if (!surfaces || surfaces.some((surface) => !SURFACES.has(surface as AgentSurface))) return invalid();

  if (!Array.isArray(value.installDetectors)
    || value.installDetectors.length === 0
    || value.installDetectors.length > MAX_DETECTORS_PER_AGENT) {
    return invalid();
  }
  const installDetectors: AgentInstallDetector[] = [];
  for (const detector of value.installDetectors) {
    const validated = validateInstallDetector(detector);
    if (!validated) return invalid();
    installDetectors.push(validated);
  }

  if (!Array.isArray(value.processDetectors)
    || value.processDetectors.length > MAX_DETECTORS_PER_AGENT) {
    return invalid();
  }
  const processDetectors: AgentProcessDetector[] = [];
  for (const detector of value.processDetectors) {
    const validated = validateProcessDetector(detector);
    if (!validated) return invalid();
    processDetectors.push(validated);
  }

  if (!validCapabilities(value.capabilities) || !validPrivacy(value.privacy)) return invalid();

  return {
    ok: true,
    definition: {
      schemaVersion: 1,
      id: value.id,
      provider: value.provider,
      displayName: value.displayName.trim(),
      enabled: value.enabled,
      surfaces: surfaces as AgentSurface[],
      installDetectors,
      processDetectors,
      capabilities: value.capabilities as AgentDetectorDefinition["capabilities"],
      privacy: value.privacy as AgentDetectorPrivacy,
      source: "user",
      revision: value.revision as number
    }
  };
}

function validateInstallDetector(value: unknown): AgentInstallDetector | null {
  const detector = record(value);
  if (!detector || typeof detector.type !== "string") return null;
  if (detector.type === "executable") {
    if (!exactKeys(detector, ["type", "names"])) return null;
    const names = stringArray(detector.names, MAX_VALUES_PER_DETECTOR);
    if (!names || names.some((name) => !EXECUTABLE_PATTERN.test(name))) return null;
    return { type: "executable", names };
  }
  if (detector.type === "app_bundle") {
    if (!exactKeys(detector, ["type", "paths", "bundleIdentifiers", "readVersion"])) return null;
    const paths = stringArray(detector.paths, MAX_VALUES_PER_DETECTOR);
    const bundleIdentifiers = stringArray(detector.bundleIdentifiers, MAX_VALUES_PER_DETECTOR, true);
    if (!paths || !bundleIdentifiers || typeof detector.readVersion !== "boolean") return null;
    if (paths.some((path) => !APP_PATH_PATTERN.test(path))) return null;
    if (bundleIdentifiers.some((id) => !BUNDLE_ID_PATTERN.test(id))) return null;
    return {
      type: "app_bundle",
      paths,
      bundleIdentifiers,
      readVersion: detector.readVersion
    };
  }
  return null;
}

function validateBuiltinPathOverride(
  definition: AgentDetectorDefinition,
  value: unknown
): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (
    path.length === 0
    || path.length > 1_024
    || path !== value
    || /[\u0000-\u001f\u007f]/.test(path)
    || (!path.startsWith("/") && !path.startsWith("~/"))
    || path.split("/").includes("..")
  ) return null;

  if (path.endsWith(".app")) {
    return definition.installDetectors.some((detector) => detector.type === "app_bundle"
      && detector.paths.some((candidate) => basename(candidate) === basename(path)))
      ? path
      : null;
  }
  const executableNames = definition.installDetectors.flatMap((detector) =>
    detector.type === "executable" ? detector.names : []
  );
  return executableNames.includes(basename(path)) ? path : null;
}

function applyBuiltinPathOverride(
  definition: AgentDetectorDefinition,
  path: string
): AgentDetectorDefinition {
  if (!path.endsWith(".app")) {
    const expectedNames = definition.installDetectors.flatMap((detector) =>
      detector.type === "executable" ? detector.names : []
    );
    return {
      ...definition,
      installDetectors: [{ type: "executable_path", paths: [path], expectedNames }, ...definition.installDetectors]
    };
  }

  const matching = definition.installDetectors.find((detector) => detector.type === "app_bundle"
    && detector.paths.some((candidate) => basename(candidate) === basename(path)));
  if (!matching || matching.type !== "app_bundle") return definition;
  return {
    ...definition,
    installDetectors: [{
      type: "app_bundle",
      paths: [path],
      bundleIdentifiers: [...matching.bundleIdentifiers],
      readVersion: matching.readVersion
    }, ...definition.installDetectors]
  };
}

function validateProcessDetector(value: unknown): AgentProcessDetector | null {
  const detector = record(value);
  if (!detector || !exactKeys(detector, ["type", "names"]) || detector.type !== "exact_name") return null;
  const names = stringArray(detector.names, MAX_VALUES_PER_DETECTOR);
  if (!names || names.some((name) => !PROCESS_NAME_PATTERN.test(name))) return null;
  return { type: "exact_name", names };
}

function validCapabilities(value: unknown): boolean {
  const capabilities = record(value);
  return Boolean(capabilities
    && exactKeys(capabilities, ["installation", "version", "runtime", "activity", "entitlement", "quota"])
    && capabilities.installation === true
    && typeof capabilities.version === "boolean"
    && typeof capabilities.runtime === "boolean"
    && capabilities.activity === false
    && capabilities.entitlement === false
    && capabilities.quota === false);
}

function validPrivacy(value: unknown): boolean {
  const privacy = record(value);
  return Boolean(privacy
    && exactKeys(privacy, [
      "collectPaths",
      "collectCommands",
      "collectContent",
      "networkAllowed",
      "shareByDefault"
    ])
    && privacy.collectPaths === false
    && privacy.collectCommands === false
    && privacy.collectContent === false
    && privacy.networkAllowed === false
    && privacy.shareByDefault === false);
}

function catalog(
  definitions: AgentDetectorDefinition[],
  errors: ObservationSafeError[] = []
): AgentDetectorCatalog {
  return {
    schemaVersion: 1,
    discoveryEnabled: true,
    customDetectorsEnabled: true,
    definitions,
    errors
  };
}

function invalid(code = "AGENT_CONFIG_ENTRY_INVALID"): CustomValidation {
  return { ok: false, code };
}

function safeError(code: string): ObservationSafeError {
  return { code, recoverable: true };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  return value === undefined ? fallback : typeof value === "boolean" ? value : null;
}

function stringArray(value: unknown, max: number, allowEmpty = false): string[] | null {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) return null;
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 128)) return null;
  return [...new Set(value as string[])];
}

function isSafeDisplayName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0
    && trimmed.length <= 80
    && !/[\u0000-\u001f\u007f]/.test(trimmed);
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function readUtf8(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function readConfigRootForMutation(path: string): Promise<Record<string, unknown> & { agents?: unknown[] }> {
  let value: unknown;
  try {
    value = JSON.parse(await readUtf8(path));
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return { schemaVersion: 1, agents: [] };
    throw new AgentDetectorConfigurationError("AGENT_CONFIG_WRITE_BLOCKED");
  }
  const root = record(value);
  if (
    !root
    || !exactKeys(root, ["schemaVersion", "discoveryEnabled", "customDetectorsEnabled", "agents"])
    || root.schemaVersion !== 1
    || optionalBoolean(root.discoveryEnabled, true) === null
    || optionalBoolean(root.customDetectorsEnabled, true) === null
    || (root.agents !== undefined
      && (!Array.isArray(root.agents) || root.agents.length > MAX_AGENT_CONFIG_ENTRIES))
  ) {
    throw new AgentDetectorConfigurationError("AGENT_CONFIG_WRITE_BLOCKED");
  }
  const ids = new Set<string>();
  for (const entry of root.agents ?? []) {
    const candidate = record(entry);
    if (!candidate || typeof candidate.id !== "string" || ids.has(candidate.id)) {
      throw new AgentDetectorConfigurationError("AGENT_CONFIG_WRITE_BLOCKED");
    }
    ids.add(candidate.id);
  }
  return root as Record<string, unknown> & { agents?: unknown[] };
}

async function writeConfigAtomically(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
