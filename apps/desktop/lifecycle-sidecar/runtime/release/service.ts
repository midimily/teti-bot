import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  TETI_RELEASE_POLICY_SCHEMA_VERSION,
  TETI_RELEASE_STATUS_SCHEMA_VERSION,
  releaseStateForPolicy,
  validateTetiReleasePolicy,
  type LocalReleaseStatus,
  type TetiReleasePolicy
} from "../../../../../core/release/policy.ts";
import type { TetiNetworkClient } from "../../../../../services/network/types.ts";
import { TetiNetworkClientError } from "../../../../../services/network/errors.ts";

export const TETI_RELEASE_POLICY_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;

interface CachedReleasePolicy {
  schemaVersion: 1;
  policy: TetiReleasePolicy;
  checkedAt: string;
}

export interface ReleasePolicyStore {
  load(): Promise<CachedReleasePolicy | null>;
  save(value: CachedReleasePolicy): Promise<void>;
}

export interface ReleasePolicyClient {
  getPolicy(): Promise<TetiReleasePolicy>;
}

export interface LocalReleasePolicyServiceOptions {
  currentVersion: string;
  buildTimestamp: string;
  store: ReleasePolicyStore;
  client: ReleasePolicyClient;
  now?: () => Date;
}

export class LocalReleasePolicyService {
  private readonly currentVersion: string;
  private readonly buildTimestamp: string;
  private readonly store: ReleasePolicyStore;
  private readonly client: ReleasePolicyClient;
  private readonly now: () => Date;
  private cached: CachedReleasePolicy | null = null;
  private statusValue: LocalReleaseStatus;

  constructor(options: LocalReleasePolicyServiceOptions) {
    this.currentVersion = options.currentVersion;
    this.buildTimestamp = options.buildTimestamp;
    this.store = options.store;
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    this.statusValue = this.baseStatus("checking", "none");
  }

  getStatus(): LocalReleaseStatus {
    return structuredClone(this.statusValue);
  }

  async initialize(): Promise<LocalReleaseStatus> {
    try {
      const cached = await this.store.load();
      if (cached) {
        this.cached = validateCachedReleasePolicy(cached);
        this.statusValue = this.statusFromPolicy(this.cached.policy, "cache", this.cached.checkedAt);
      }
    } catch {
      this.statusValue = {
        ...this.baseStatus("checking", "none"),
        diagnosticCode: "RELEASE_POLICY_INVALID"
      };
    }
    return this.getStatus();
  }

  async refresh(): Promise<LocalReleaseStatus> {
    let policy: TetiReleasePolicy;
    try {
      const incoming = validateTetiReleasePolicy(await this.client.getPolicy());
      policy = acceptPolicy(this.cached?.policy, incoming);
    } catch (error) {
      this.handleRefreshFailure(error);
      return this.getStatus();
    }

    const checkedAt = this.now().toISOString();
    const cached = {
      schemaVersion: TETI_RELEASE_POLICY_SCHEMA_VERSION,
      policy,
      checkedAt
    } satisfies CachedReleasePolicy;
    this.cached = cached;
    this.statusValue = this.statusFromPolicy(policy, "network", checkedAt);
    try {
      await this.store.save(cached);
    } catch {
      // A verified network floor still applies to this process even if its cache cannot be persisted.
      this.statusValue = { ...this.statusValue, diagnosticCode: "RELEASE_POLICY_INVALID" };
    }
    return this.getStatus();
  }

  private handleRefreshFailure(error: unknown): void {
    if (this.cached) {
      const cachedStatus = this.statusFromPolicy(
        this.cached.policy,
        "cache",
        this.cached.checkedAt
      );
      this.statusValue = cachedStatus.state === "update_required"
        ? cachedStatus
        : { ...cachedStatus, state: "temporarily_unavailable", diagnosticCode: diagnosticCode(error) };
      return;
    }
    this.statusValue = {
      ...this.baseStatus("temporarily_unavailable", "none"),
      diagnosticCode: diagnosticCode(error)
    };
  }

  private statusFromPolicy(
    policy: TetiReleasePolicy,
    source: "cache" | "network",
    checkedAt: string
  ): LocalReleaseStatus {
    return {
      ...this.baseStatus(releaseStateForPolicy(this.currentVersion, policy, this.now()), source),
      checkedAt,
      minimumSupportedVersion: policy.minimumSupportedVersion,
      policyVersion: policy.policyVersion,
      effectiveAt: policy.effectiveAt
    };
  }

  private baseStatus(
    state: LocalReleaseStatus["state"],
    source: LocalReleaseStatus["source"]
  ): LocalReleaseStatus {
    return {
      schemaVersion: TETI_RELEASE_STATUS_SCHEMA_VERSION,
      state,
      currentVersion: this.currentVersion,
      buildTimestamp: this.buildTimestamp,
      source
    };
  }
}

export class FileReleasePolicyStore implements ReleasePolicyStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<CachedReleasePolicy | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as CachedReleasePolicy;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(value: CachedReleasePolicy): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
  }
}

/** Reads the App release floor from the official versioned Network bootstrap. */
export class NetworkBootstrapReleasePolicyClient implements ReleasePolicyClient {
  private readonly networkClient: TetiNetworkClient;

  constructor(networkClient: TetiNetworkClient) {
    this.networkClient = networkClient;
  }

  async getPolicy(): Promise<TetiReleasePolicy> {
    return validateTetiReleasePolicy((await this.networkClient.getBootstrap()).releasePolicy);
  }
}

function validateCachedReleasePolicy(value: CachedReleasePolicy): CachedReleasePolicy {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Cached Release Policy schema is unsupported.");
  }
  if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) {
    throw new Error("Cached Release Policy timestamp is invalid.");
  }
  return {
    schemaVersion: 1,
    policy: validateTetiReleasePolicy(value.policy),
    checkedAt: new Date(value.checkedAt).toISOString()
  };
}

function acceptPolicy(
  current: TetiReleasePolicy | undefined,
  incoming: TetiReleasePolicy
): TetiReleasePolicy {
  if (!current) return incoming;
  if (incoming.policyVersion < current.policyVersion) {
    throw new Error("Release Policy version regressed.");
  }
  if (incoming.policyVersion === current.policyVersion
    && JSON.stringify(incoming) !== JSON.stringify(current)) {
    throw new Error("Release Policy changed without a version increment.");
  }
  return incoming;
}

function diagnosticCode(error: unknown): LocalReleaseStatus["diagnosticCode"] {
  return error instanceof TypeError
    || (error instanceof TetiNetworkClientError
      && error.code !== "NETWORK_INVALID_RESPONSE"
      && error.code !== "PROTOCOL_UNSUPPORTED")
    ? "RELEASE_POLICY_UNAVAILABLE"
    : "RELEASE_POLICY_INVALID";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
