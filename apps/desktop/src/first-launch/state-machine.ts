import type { TetiAccount } from "../../../../core/account/model.ts";

export type FirstLaunchStateName =
  | "booting"
  | "checking_existing_account"
  | "welcome"
  | "naming"
  | "creating_identity"
  | "registering_discovery"
  | "ready"
  | "idle"
  | "recoverable_error"
  | "fatal_error";

export type FirstLaunchCreationPhase =
  | "preparing"
  | "provisioning_chatmail"
  | "persisting_account"
  | "registering_identity"
  | "verifying_account"
  | "finalizing";

export type FirstLaunchErrorKind =
  | "invalid_name"
  | "temporary_account_load_failure"
  | "corrupt_account"
  | "partial_account"
  | "chatmail_provisioning_failure"
  | "local_persistence_failure"
  | "discovery_registration_failure"
  | "loaded_account_verification_failure"
  | "unrecoverable_internal_state";

export interface FirstLaunchError {
  kind: FirstLaunchErrorKind;
  message: string;
  recoverable: boolean;
}

export interface FirstLaunchSnapshot {
  state: FirstLaunchStateName;
  nameInput: string;
  submitting: boolean;
  phase?: FirstLaunchCreationPhase;
  account?: TetiAccount;
  error?: FirstLaunchError;
}

type FirstLaunchEvent =
  | { type: "start_check" }
  | { type: "no_account" }
  | { type: "account_loaded"; account: TetiAccount }
  | { type: "account_registration_pending"; account: TetiAccount; error: FirstLaunchError }
  | { type: "load_failed"; error: FirstLaunchError }
  | { type: "show_naming" }
  | { type: "update_name"; value: string }
  | { type: "submit_name"; value: string }
  | { type: "creation_phase"; phase: FirstLaunchCreationPhase }
  | { type: "creation_succeeded"; account: TetiAccount }
  | { type: "creation_failed"; error: FirstLaunchError; account?: TetiAccount }
  | { type: "registration_retry_started" }
  | { type: "registration_retry_succeeded"; account: TetiAccount }
  | { type: "registration_retry_failed"; error: FirstLaunchError }
  | { type: "collapse_to_idle" }
  | { type: "fatal"; error: FirstLaunchError };

export class InvalidFirstLaunchTransitionError extends Error {}

export class FirstLaunchStateMachine {
  private snapshotValue: FirstLaunchSnapshot = {
    state: "booting",
    nameInput: "",
    submitting: false
  };

  get snapshot(): FirstLaunchSnapshot {
    return cloneSnapshot(this.snapshotValue);
  }

  transition(event: FirstLaunchEvent): FirstLaunchSnapshot {
    const current = this.snapshotValue;
    this.snapshotValue = this.reduce(current, event);
    return this.snapshot;
  }

  private reduce(
    current: FirstLaunchSnapshot,
    event: FirstLaunchEvent
  ): FirstLaunchSnapshot {
    switch (event.type) {
      case "start_check":
        this.assertState(current, event.type, ["booting", "fatal_error"]);
        return { state: "checking_existing_account", nameInput: current.nameInput, submitting: false };

      case "no_account":
        this.assertState(current, event.type, ["checking_existing_account"]);
        return { state: "welcome", nameInput: current.nameInput, submitting: false };

      case "account_loaded":
        this.assertState(current, event.type, [
          "checking_existing_account",
          "creating_identity",
          "registering_discovery",
          "recoverable_error"
        ]);
        return {
          state: "idle",
          nameInput: event.account.displayName ?? current.nameInput,
          submitting: false,
          account: event.account
        };

      case "account_registration_pending":
        this.assertState(current, event.type, ["checking_existing_account"]);
        return {
          state: "recoverable_error",
          nameInput: event.account.displayName ?? current.nameInput,
          submitting: false,
          account: event.account,
          error: event.error
        };

      case "load_failed":
        this.assertState(current, event.type, ["checking_existing_account"]);
        return {
          state: event.error.recoverable ? "recoverable_error" : "fatal_error",
          nameInput: current.nameInput,
          submitting: false,
          error: event.error
        };

      case "show_naming":
        this.assertState(current, event.type, ["welcome", "recoverable_error"]);
        return {
          state: "naming",
          nameInput: current.nameInput,
          submitting: false
        };

      case "update_name":
        this.assertState(current, event.type, ["welcome", "naming", "recoverable_error"]);
        return {
          ...current,
          state: current.state === "welcome" ? "naming" : current.state,
          nameInput: event.value,
          error: current.error?.kind === "invalid_name" ? undefined : current.error
        };

      case "submit_name":
        this.assertState(current, event.type, ["welcome", "naming", "recoverable_error"]);
        return {
          state: "creating_identity",
          nameInput: event.value,
          submitting: true,
          phase: "preparing"
        };

      case "creation_phase":
        this.assertState(current, event.type, ["creating_identity"]);
        return {
          ...current,
          phase: event.phase,
          submitting: true
        };

      case "creation_succeeded":
        this.assertState(current, event.type, ["creating_identity", "registering_discovery"]);
        return {
          state: "ready",
          nameInput: event.account.displayName ?? current.nameInput,
          submitting: false,
          phase: "finalizing",
          account: event.account
        };

      case "creation_failed":
        this.assertState(current, event.type, ["welcome", "naming", "creating_identity", "recoverable_error"]);
        return {
          state: event.error.recoverable ? "recoverable_error" : "fatal_error",
          nameInput: current.nameInput,
          submitting: false,
          account: event.account,
          error: event.error
        };

      case "registration_retry_started":
        this.assertState(current, event.type, ["recoverable_error"]);
        return {
          ...current,
          state: "registering_discovery",
          submitting: true,
          phase: "registering_identity",
          error: undefined
        };

      case "registration_retry_succeeded":
        this.assertState(current, event.type, ["registering_discovery"]);
        return {
          state: "ready",
          nameInput: event.account.displayName ?? current.nameInput,
          submitting: false,
          phase: "finalizing",
          account: event.account
        };

      case "registration_retry_failed":
        this.assertState(current, event.type, ["registering_discovery"]);
        return {
          state: "recoverable_error",
          nameInput: current.nameInput,
          submitting: false,
          account: current.account,
          error: event.error
        };

      case "collapse_to_idle":
        this.assertState(current, event.type, ["ready"]);
        return {
          state: "idle",
          nameInput: current.nameInput,
          submitting: false,
          account: current.account
        };

      case "fatal":
        return {
          state: "fatal_error",
          nameInput: current.nameInput,
          submitting: false,
          account: current.account,
          error: event.error
        };
    }
  }

  private assertState(
    current: FirstLaunchSnapshot,
    eventType: string,
    allowed: FirstLaunchStateName[]
  ): void {
    if (!allowed.includes(current.state)) {
      throw new InvalidFirstLaunchTransitionError(
        `Cannot apply ${eventType} while first launch is ${current.state}.`
      );
    }
  }
}

export function createFirstLaunchError(
  kind: FirstLaunchErrorKind,
  message: string,
  recoverable = true
): FirstLaunchError {
  return {
    kind,
    message,
    recoverable
  };
}

function cloneSnapshot(snapshot: FirstLaunchSnapshot): FirstLaunchSnapshot {
  return {
    ...snapshot,
    account: snapshot.account ? { ...snapshot.account } : undefined,
    error: snapshot.error ? { ...snapshot.error } : undefined
  };
}
