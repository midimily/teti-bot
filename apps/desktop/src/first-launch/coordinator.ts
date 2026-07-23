import type { DiscoveryClient } from "../../../../services/discovery/registry-client.ts";
import { validateTetiDisplayName } from "../../../../core/account/display-name.ts";
import type {
  DiscoveryRegistrationPayload,
  TetiAccount,
  TetiStatus
} from "../../../../core/account/model.ts";
import {
  createFirstLaunchError,
  FirstLaunchStateMachine,
  type FirstLaunchError,
  type FirstLaunchSnapshot
} from "./state-machine.ts";
import type { NotchWindowController } from "./notch-window.ts";

export interface FirstLaunchAccountLifecycle {
  loadTetiAccount(): Promise<TetiAccount | null>;
  createTetiAccount(input: { name: string }): Promise<TetiAccount>;
  getTetiStatus?(): Promise<TetiStatus>;
}

export interface FirstLaunchDiagnostics {
  warn(event: string, detail: Record<string, unknown>): void;
  error(event: string, detail: Record<string, unknown>): void;
}

export interface FirstLaunchCoordinatorOptions {
  accountLifecycle: FirstLaunchAccountLifecycle;
  notchWindow: NotchWindowController;
  discoveryClient?: Pick<DiscoveryClient, "registerIdentity">;
  diagnostics?: FirstLaunchDiagnostics;
  readyCollapseDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

export class FirstLaunchCoordinator {
  private readonly stateMachine = new FirstLaunchStateMachine();
  private readonly accountLifecycle: FirstLaunchAccountLifecycle;
  private readonly notchWindow: NotchWindowController;
  private readonly discoveryClient?: Pick<DiscoveryClient, "registerIdentity">;
  private readonly diagnostics: FirstLaunchDiagnostics;
  private readonly readyCollapseDelayMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private creationInFlight: Promise<FirstLaunchSnapshot> | null = null;
  private discoveryRetryInFlight: Promise<FirstLaunchSnapshot> | null = null;

  constructor(options: FirstLaunchCoordinatorOptions) {
    this.accountLifecycle = options.accountLifecycle;
    this.notchWindow = options.notchWindow;
    this.discoveryClient = options.discoveryClient;
    this.diagnostics = options.diagnostics ?? new NoopDiagnostics();
    this.readyCollapseDelayMs = options.readyCollapseDelayMs ?? 900;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  get snapshot(): FirstLaunchSnapshot {
    return this.stateMachine.snapshot;
  }

  async initialize(): Promise<FirstLaunchSnapshot> {
    this.stateMachine.transition({ type: "start_check" });

    try {
      const account = await this.accountLifecycle.loadTetiAccount();
      if (account) {
        const snapshot = this.stateMachine.transition({ type: "account_loaded", account });
        await this.notchWindow.collapse("existing-account");
        return snapshot;
      }

      const snapshot = this.stateMachine.transition({ type: "no_account" });
      await this.notchWindow.expand("first-launch");
      return snapshot;
    } catch (error) {
      const firstLaunchError = classifyAccountLoadError(error);
      this.diagnostics.error("first_launch_account_load_failed", sanitizeError(error));
      const snapshot = this.stateMachine.transition({
        type: "load_failed",
        error: firstLaunchError
      });
      if (firstLaunchError.recoverable) {
        await this.notchWindow.expand("account-load-recoverable-error");
      } else {
        await this.notchWindow.expand("account-load-fatal-error");
      }
      return snapshot;
    }
  }

  showNaming(): FirstLaunchSnapshot {
    return this.stateMachine.transition({ type: "show_naming" });
  }

  updateName(value: string): FirstLaunchSnapshot {
    return this.stateMachine.transition({ type: "update_name", value });
  }

  async submitName(rawName?: string): Promise<FirstLaunchSnapshot> {
    if (this.creationInFlight) {
      return this.snapshot;
    }

    const validation = validateTetiDisplayName(rawName ?? this.snapshot.nameInput);
    if (!validation.ok) {
      return this.stateMachine.transition({
        type: "creation_failed",
        error: createFirstLaunchError("invalid_name", validation.message)
      });
    }
    const name = validation.value;

    this.stateMachine.transition({ type: "submit_name", value: name });
    this.creationInFlight = (async () => {
      await this.notchWindow.expand("creating-identity");
      return this.createIdentity(name);
    })();
    try {
      return await this.creationInFlight;
    } finally {
      this.creationInFlight = null;
    }
  }

  async retryDiscoveryRegistration(): Promise<FirstLaunchSnapshot> {
    if (this.discoveryRetryInFlight) {
      return this.snapshot;
    }

    if (!this.discoveryClient) {
      return this.stateMachine.transition({
        type: "registration_retry_failed",
        error: createFirstLaunchError(
          "discovery_registration_failure",
          "Teti could not finish connecting yet."
        )
      });
    }

    this.discoveryRetryInFlight = this.retryDiscovery();
    try {
      return await this.discoveryRetryInFlight;
    } finally {
      this.discoveryRetryInFlight = null;
    }
  }

  collapseReadyToIdle(): FirstLaunchSnapshot {
    const snapshot = this.stateMachine.transition({ type: "collapse_to_idle" });
    void this.notchWindow.collapse("ready-to-idle");
    return snapshot;
  }

  private async createIdentity(name: string): Promise<FirstLaunchSnapshot> {
    try {
      this.stateMachine.transition({ type: "creation_phase", phase: "provisioning_chatmail" });
      const created = await this.accountLifecycle.createTetiAccount({ name });

      this.stateMachine.transition({ type: "creation_phase", phase: "verifying_account" });
      const verified = await this.verifyLoadedAccount(created);

      const snapshot = this.stateMachine.transition({
        type: "creation_succeeded",
        account: verified
      });
      this.scheduleReadyCollapse();
      return snapshot;
    } catch (error) {
      const persistedAccount = await this.tryLoadPersistedAccountAfterFailure(error);
      if (persistedAccount && !isFirstLaunchError(error)) {
        this.diagnostics.warn("first_launch_recovered_from_post_save_failure", sanitizeError(error));
        const snapshot = this.stateMachine.transition({
          type: "creation_succeeded",
          account: persistedAccount
        });
        this.scheduleReadyCollapse();
        return snapshot;
      }
      const firstLaunchError = classifyCreationError(error);

      this.diagnostics.error("first_launch_create_failed", {
        ...sanitizeError(error),
        classifiedAs: firstLaunchError.kind,
        accountPersisted: Boolean(persistedAccount)
      });

      return this.stateMachine.transition({
        type: "creation_failed",
        error: firstLaunchError,
        account: persistedAccount ?? undefined
      });
    }
  }

  private async retryDiscovery(): Promise<FirstLaunchSnapshot> {
    this.stateMachine.transition({ type: "registration_retry_started" });

    try {
      const account = this.snapshot.account ?? (await this.accountLifecycle.loadTetiAccount());
      if (!account) {
        return this.stateMachine.transition({
          type: "registration_retry_failed",
          error: createFirstLaunchError(
            "loaded_account_verification_failure",
            "Teti could not verify the local identity.",
            false
          )
        });
      }

      await this.discoveryClient?.registerIdentity(toDiscoveryRegistrationPayload(account));
      const verified = await this.verifyLoadedAccount(account);
      const snapshot = this.stateMachine.transition({
        type: "registration_retry_succeeded",
        account: verified
      });
      this.scheduleReadyCollapse();
      return snapshot;
    } catch (error) {
      this.diagnostics.warn("first_launch_discovery_retry_failed", sanitizeError(error));
      return this.stateMachine.transition({
        type: "registration_retry_failed",
        error: createFirstLaunchError(
          "discovery_registration_failure",
          "Teti could not finish connecting yet."
        )
      });
    }
  }

  private async verifyLoadedAccount(expected: TetiAccount): Promise<TetiAccount> {
    const loaded = await this.accountLifecycle.loadTetiAccount();
    if (!loaded || loaded.id !== expected.id || loaded.chatmailAccountId !== expected.chatmailAccountId) {
      throw createFirstLaunchError(
        "loaded_account_verification_failure",
        "Teti could not verify the local identity.",
        false
      );
    }

    return loaded;
  }

  private async tryLoadPersistedAccountAfterFailure(error: unknown): Promise<TetiAccount | null> {
    try {
      return await this.accountLifecycle.loadTetiAccount();
    } catch (loadError) {
      this.diagnostics.warn("first_launch_post_failure_load_failed", {
        original: sanitizeError(error),
        load: sanitizeError(loadError)
      });
      return null;
    }
  }

  private scheduleReadyCollapse(): void {
    this.schedule(() => {
      if (this.snapshot.state === "ready") {
        this.collapseReadyToIdle();
      }
    }, this.readyCollapseDelayMs);
  }
}

export function normalizeDisplayName(input: string): string {
  const validation = validateTetiDisplayName(input);
  return validation.ok ? validation.value : "";
}

export function sanitizeError(error: unknown): Record<string, unknown> {
  if (isFirstLaunchError(error)) {
    return {
      kind: error.kind,
      message: error.message,
      recoverable: error.recoverable,
      diagnosticCode: error.diagnosticCode
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSecretLikeText(error.message)
    };
  }

  return {
    message: redactSecretLikeText(String(error))
  };
}

function classifyAccountLoadError(error: unknown): FirstLaunchError {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Unsupported Teti account version") ||
    message.includes("must not contain") ||
    message.includes("required")
  ) {
    return createFirstLaunchError("corrupt_account", "Teti found local identity data that needs repair.", false);
  }

  return createFirstLaunchError(
    "temporary_account_load_failure",
    "Teti could not check the local identity yet."
  );
}

function classifyCreationError(error: unknown): FirstLaunchError {
  if (isFirstLaunchError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const diagnosticCode = readDiagnosticCode(error);
  if (diagnosticCode?.startsWith("CM_")) {
    return createFirstLaunchError(
      "chatmail_provisioning_failure",
      "Chatmail 身份初始化未完成。",
      true,
      diagnosticCode
    );
  }
  if (diagnosticCode?.startsWith("LOC_")) {
    return createFirstLaunchError(
      "local_persistence_failure",
      "Teti 无法安全保存本机身份。",
      false,
      diagnosticCode
    );
  }
  if (/(save|persist|storage|write|rename|EACCES|EPERM|ENOSPC)/i.test(message)) {
    return createFirstLaunchError(
      "local_persistence_failure",
      "Teti could not safely save its identity.",
      false
    );
  }

  if (/(network|fetch|registry|discover|register|cloudflare|ECONN|ENOTFOUND|timeout)/i.test(message)) {
    return createFirstLaunchError(
      "discovery_registration_failure",
      "Teti could not finish connecting yet."
    );
  }

  return createFirstLaunchError(
    "chatmail_provisioning_failure",
    "Teti could not finish setting up."
  );
}

function readDiagnosticCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("diagnosticCode" in error)) return undefined;
  const code = error.diagnosticCode;
  return typeof code === "string" ? code : undefined;
}

function isFirstLaunchError(error: unknown): error is FirstLaunchError {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "recoverable" in error &&
    "message" in error
  );
}

function redactSecretLikeText(text: string): string {
  return text
    .replace(/password=[^\s]+/gi, "password=[redacted]")
    .replace(/token=[^\s]+/gi, "token=[redacted]")
    .replace(/secret=[^\s]+/gi, "secret=[redacted]")
    .replace(/private[-_ ]?key[^\s]*/gi, "private-key[redacted]")
    .slice(0, 300);
}

class NoopDiagnostics implements FirstLaunchDiagnostics {
  warn(): void {}
  error(): void {}
}

function toDiscoveryRegistrationPayload(account: TetiAccount): DiscoveryRegistrationPayload {
  const payload: DiscoveryRegistrationPayload = {
    version: 1,
    id: account.id,
    address: account.address,
    publicProfile: account.publicProfile
  };

  if (account.publicKey) {
    payload.publicKey = account.publicKey;
  }

  return payload;
}
