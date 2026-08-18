import { validateTetiDisplayName } from "../../../../core/account/display-name.ts";
import type { TetiAccount, TetiStatus } from "../../../../core/account/model.ts";
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
  synchronizeNetworkIdentity(): Promise<TetiAccount>;
}

export interface FirstLaunchDiagnostics {
  warn(event: string, detail: Record<string, unknown>): void;
  error(event: string, detail: Record<string, unknown>): void;
}

export interface FirstLaunchCoordinatorOptions {
  accountLifecycle: FirstLaunchAccountLifecycle;
  notchWindow: NotchWindowController;
  diagnostics?: FirstLaunchDiagnostics;
  readyCollapseDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

export class FirstLaunchCoordinator {
  private readonly stateMachine = new FirstLaunchStateMachine();
  private readonly accountLifecycle: FirstLaunchAccountLifecycle;
  private readonly notchWindow: NotchWindowController;
  private readonly diagnostics: FirstLaunchDiagnostics;
  private readonly readyCollapseDelayMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private creationInFlight: Promise<FirstLaunchSnapshot> | null = null;
  private networkIdentityRetryInFlight: Promise<FirstLaunchSnapshot> | null = null;

  constructor(options: FirstLaunchCoordinatorOptions) {
    this.accountLifecycle = options.accountLifecycle;
    this.notchWindow = options.notchWindow;
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
        error: createFirstLaunchError("invalid_name", {
          validationReason: validation.reason
        })
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

  async retryNetworkIdentity(): Promise<FirstLaunchSnapshot> {
    if (this.networkIdentityRetryInFlight) {
      return this.snapshot;
    }

    if (!this.accountLifecycle.synchronizeNetworkIdentity) {
      return this.stateMachine.transition({
        type: "registration_retry_failed",
        error: createFirstLaunchError("network_identity_failure")
      });
    }

    this.networkIdentityRetryInFlight = this.retryNetworkIdentitySynchronization();
    try {
      return await this.networkIdentityRetryInFlight;
    } finally {
      this.networkIdentityRetryInFlight = null;
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

  private async retryNetworkIdentitySynchronization(): Promise<FirstLaunchSnapshot> {
    this.stateMachine.transition({ type: "registration_retry_started" });

    try {
      const account = this.snapshot.account ?? (await this.accountLifecycle.loadTetiAccount());
      if (!account) {
        return this.stateMachine.transition({
          type: "registration_retry_failed",
          error: createFirstLaunchError("loaded_account_verification_failure", {
            recoverable: false
          })
        });
      }

      const synchronized = await this.accountLifecycle.synchronizeNetworkIdentity();
      const verified = await this.verifyLoadedAccount(synchronized);
      const snapshot = this.stateMachine.transition({
        type: "registration_retry_succeeded",
        account: verified
      });
      this.scheduleReadyCollapse();
      return snapshot;
    } catch (error) {
      this.diagnostics.warn("first_launch_network_identity_retry_failed", sanitizeError(error));
      return this.stateMachine.transition({
        type: "registration_retry_failed",
        error: createFirstLaunchError("network_identity_failure")
      });
    }
  }

  private async verifyLoadedAccount(expected: TetiAccount): Promise<TetiAccount> {
    const loaded = await this.accountLifecycle.loadTetiAccount();
    if (!loaded || loaded.id !== expected.id || loaded.chatmailAccountId !== expected.chatmailAccountId) {
      throw createFirstLaunchError(
        "loaded_account_verification_failure",
        { recoverable: false }
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
      recoverable: error.recoverable,
      diagnosticCode: error.diagnosticCode,
      validationReason: error.validationReason
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
    return createFirstLaunchError("corrupt_account", { recoverable: false });
  }

  return createFirstLaunchError("temporary_account_load_failure");
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
      { diagnosticCode }
    );
  }
  if (diagnosticCode?.startsWith("LOC_")) {
    return createFirstLaunchError(
      "local_persistence_failure",
      { recoverable: false, diagnosticCode }
    );
  }
  if (/(save|persist|storage|write|rename|EACCES|EPERM|ENOSPC)/i.test(message)) {
    return createFirstLaunchError(
      "local_persistence_failure",
      { recoverable: false }
    );
  }

  if (/(network|fetch|identity|register|ECONN|ENOTFOUND|timeout)/i.test(message)) {
    return createFirstLaunchError("network_identity_failure");
  }

  if (/(chatmail|provision|rpc)/i.test(message)) {
    return createFirstLaunchError("chatmail_provisioning_failure");
  }

  return createFirstLaunchError("unknown_failure");
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
    "diagnosticCode" in error
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
