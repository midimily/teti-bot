import type { FirstLaunchSnapshot } from "./state-machine.ts";
import {
  TETI_DISPLAY_NAME_MAX_CHARACTERS,
  type DisplayNameValidationReason
} from "../../../../core/account/display-name.ts";
import { formatMessage, type DesktopI18n } from "../i18n/index.ts";

export interface FirstLaunchViewModel {
  panel: "collapsed" | "expanded";
  character: "idle" | "wake" | "naming" | "thinking" | "ready" | "error";
  title: string;
  message: string;
  primaryAction?: string;
  primaryActionKind?: "show_naming" | "submit_name" | "finish" | "retry_network";
  input?: {
    value: string;
    placeholder: string;
    disabled: boolean;
    error?: string;
    maxCharacters?: number;
  };
  progress?: {
    active: boolean;
    label: string;
  };
}

export function toFirstLaunchViewModel(
  snapshot: FirstLaunchSnapshot,
  i18n: DesktopI18n
): FirstLaunchViewModel {
  const messages = i18n.messages.firstLaunch;
  switch (snapshot.state) {
    case "booting":
    case "checking_existing_account":
      return {
        panel: "collapsed",
        character: "idle",
        title: i18n.messages.common.appName,
        message: messages.booting.message,
        progress: { active: true, label: messages.booting.progress }
      };

    case "welcome":
      return {
        panel: "expanded",
        character: "wake",
        title: messages.welcome.title,
        message: messages.welcome.message,
        primaryAction: messages.welcome.action,
        primaryActionKind: "show_naming"
      };

    case "naming":
      return {
        panel: "expanded",
        character: "naming",
        title: messages.naming.title,
        message: messages.naming.message,
        primaryAction: messages.naming.action,
        primaryActionKind: "submit_name",
        input: {
          value: snapshot.nameInput,
          placeholder: messages.naming.placeholder,
          disabled: false,
          maxCharacters: TETI_DISPLAY_NAME_MAX_CHARACTERS,
          error: snapshot.error?.kind === "invalid_name"
            ? displayNameValidationMessage(snapshot.error.validationReason, i18n)
            : undefined
        }
      };

    case "creating_identity":
    case "synchronizing_network_identity":
      return {
        panel: "expanded",
        character: "thinking",
        title: messages.creating.title,
        message: phaseCopy(snapshot.phase, i18n).message,
        progress: {
          active: true,
          label: phaseCopy(snapshot.phase, i18n).label
        },
        input: {
          value: snapshot.nameInput,
          placeholder: messages.naming.placeholder,
          disabled: true,
          maxCharacters: TETI_DISPLAY_NAME_MAX_CHARACTERS
        }
      };

    case "ready":
      return {
        panel: "expanded",
        character: "ready",
        title: (snapshot.account?.displayName ?? snapshot.nameInput) || i18n.messages.common.appName,
        message: messages.ready.message,
        primaryAction: messages.ready.action,
        primaryActionKind: "finish",
        progress: {
          active: false,
          label: messages.ready.progress
        }
      };

    case "idle":
      return {
        panel: "collapsed",
        character: "idle",
        title: snapshot.account?.displayName ?? i18n.messages.common.appName,
        message: messages.idleMessage
      };

    case "recoverable_error":
      const diagnosticCode = formatDiagnosticCode(snapshot.error?.diagnosticCode);
      return {
        panel: "expanded",
        character: "error",
        title: diagnosticCode
          ? formatMessage(messages.recoverable.titleWithCode, { code: diagnosticCode })
          : messages.recoverable.title,
        message: firstLaunchErrorMessage(snapshot, i18n),
        primaryAction:
          snapshot.error?.kind === "network_identity_failure"
            ? messages.recoverable.retryConnectionAction
            : messages.recoverable.retryAction,
        primaryActionKind:
          snapshot.error?.kind === "network_identity_failure" ? "retry_network" : "submit_name",
        input:
          snapshot.error?.kind === "invalid_name"
            ? {
                value: snapshot.nameInput,
                placeholder: messages.naming.placeholder,
                disabled: false,
                maxCharacters: TETI_DISPLAY_NAME_MAX_CHARACTERS,
                error: displayNameValidationMessage(snapshot.error.validationReason, i18n)
              }
            : undefined
      };

    case "fatal_error":
      return {
        panel: "expanded",
        character: "error",
        title: messages.fatalTitle,
        message: firstLaunchErrorMessage(snapshot, i18n)
      };
  }
}

function displayNameValidationMessage(
  reason: DisplayNameValidationReason | undefined,
  i18n: DesktopI18n
): string {
  const messages = i18n.messages.firstLaunch.validation;
  switch (reason) {
    case "empty":
      return messages.empty;
    case "too_long":
      return formatMessage(messages.tooLong, { maximum: TETI_DISPLAY_NAME_MAX_CHARACTERS });
    case "control_character":
      return messages.controlCharacter;
    default:
      return messages.generic;
  }
}

function firstLaunchErrorMessage(snapshot: FirstLaunchSnapshot, i18n: DesktopI18n): string {
  const messages = i18n.messages.firstLaunch.errors;
  switch (snapshot.error?.kind) {
    case "invalid_name":
      return displayNameValidationMessage(snapshot.error.validationReason, i18n);
    case "temporary_account_load_failure":
      return messages.temporaryAccountLoad;
    case "corrupt_account":
      return messages.corruptAccount;
    case "partial_account":
      return messages.partialAccount;
    case "chatmail_provisioning_failure":
      return messages.chatmailProvisioning;
    case "local_persistence_failure":
      return messages.localPersistence;
    case "network_identity_failure":
      return messages.networkIdentity;
    case "loaded_account_verification_failure":
      return messages.loadedAccountVerification;
    case "unrecoverable_internal_state":
      return snapshot.error.diagnosticCode === "RUNTIME-START"
        ? messages.runtimeStartup
        : messages.internalState;
    case "unknown_failure":
    default:
      return messages.unknown;
  }
}

function formatDiagnosticCode(code: string | undefined): string | null {
  if (!code) return null;
  if (code === "CM_RPC_NOT_FOUND" || code === "CM_RPC_DENIED" || code === "CM_RPC_INCOMPATIBLE"
    || code === "CM_RPC_LOCKED" || code === "CM_RPC_EXIT" || code === "CM_RPC_TIMEOUT"
    || code === "CM_RPC_IO") return "CM-RPC";
  if (code === "CM_CFG" || code === "CM_CFG_TIMEOUT") return "CM-CFG";
  if (code === "CM_IO" || code === "CM_IO_TIMEOUT") return "CM-IO";
  if (code === "CM_ID" || code === "CM_ID_TIMEOUT" || code === "CM_ID_INVALID") return "CM-ID";
  if (code.startsWith("LOC_")) return "LOC-SAVE";
  return null;
}

function phaseCopy(
  phase: FirstLaunchSnapshot["phase"],
  i18n: DesktopI18n
): { readonly label: string; readonly message: string } {
  return i18n.messages.firstLaunch.creating.phases[phase ?? "preparing"];
}
