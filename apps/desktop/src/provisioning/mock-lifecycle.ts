import type { TetiAccount, TetiStatus } from "../../../../core/account/model.ts";
import type { FirstLaunchAccountLifecycle } from "../first-launch/coordinator.ts";
import type { MockProvisioningScenario } from "./modes.ts";

export interface MockLifecycleOptions {
  scenario: MockProvisioningScenario;
  delayMs: number;
  initialAccount?: TetiAccount | null;
}

export class MockDesktopAccountLifecycle implements FirstLaunchAccountLifecycle {
  private account: TetiAccount | null;
  private readonly options: MockLifecycleOptions;
  readonly createCalls: string[] = [];

  constructor(options: MockLifecycleOptions) {
    this.options = options;
    this.account = options.initialAccount ?? loadMockPersistedAccount();
  }

  async loadTetiAccount(): Promise<TetiAccount | null> {
    return this.account ? cloneAccount(this.account) : null;
  }

  async createTetiAccount(input: { name: string }): Promise<TetiAccount> {
    this.createCalls.push(input.name);
    await wait(this.options.scenario === "delayed_success" ? Math.max(1200, this.options.delayMs) : this.options.delayMs);

    if (this.options.scenario === "provisioning_failure") {
      throw new Error("mock provisioning failure");
    }

    if (this.options.scenario === "persistence_failure") {
      throw new Error("mock storage write failure");
    }

    const account = createMockAccount(input.name);
    this.account = account;
    saveMockPersistedAccount(account);

    if (this.options.scenario === "discovery_failure") {
      throw new Error("mock registry fetch failed");
    }

    return cloneAccount(account);
  }

  async getTetiStatus(): Promise<TetiStatus> {
    return {
      exists: this.account !== null,
      registry: {
        state: this.account === null
          ? "unknown"
          : this.options.scenario === "discovery_failure"
            ? "unreachable"
            : "registered",
        ...(this.options.scenario === "discovery_failure"
          ? { errorCode: "REG_NETWORK", retryable: true }
          : {})
      },
      onlineStatus: "unknown"
    };
  }

  reset(): void {
    this.account = null;
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(MOCK_ACCOUNT_STORAGE_KEY);
    }
  }
}

export const MOCK_ACCOUNT_STORAGE_KEY = "teti.desktop.mockAccount";

function createMockAccount(name: string): TetiAccount {
  const normalized = name.trim() || "Teti";
  const idSafe = normalized.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 32) || "teti";
  return {
    version: 1,
    id: `teti_mock_${idSafe}`,
    address: `mock-${idSafe}@mail.seep.im`,
    displayName: normalized,
    chatmailAccountId: 1,
    publicKey: "mock-public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Teti Desktop Mock"]
    },
    createdAt: new Date().toISOString()
  };
}

function loadMockPersistedAccount(): TetiAccount | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  const raw = localStorage.getItem(MOCK_ACCOUNT_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as TetiAccount;
  } catch {
    localStorage.removeItem(MOCK_ACCOUNT_STORAGE_KEY);
    return null;
  }
}

function saveMockPersistedAccount(account: TetiAccount): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(MOCK_ACCOUNT_STORAGE_KEY, JSON.stringify(account));
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function cloneAccount(account: TetiAccount): TetiAccount {
  return JSON.parse(JSON.stringify(account)) as TetiAccount;
}
