import type { FirstLaunchSnapshot } from "./state-machine.ts";

export interface FirstLaunchViewModel {
  panel: "collapsed" | "expanded";
  character: "idle" | "wake" | "naming" | "thinking" | "ready" | "error";
  title: string;
  message: string;
  primaryAction?: string;
  input?: {
    value: string;
    placeholder: string;
    disabled: boolean;
    error?: string;
  };
  progress?: {
    active: boolean;
    label: string;
  };
}

export function toFirstLaunchViewModel(snapshot: FirstLaunchSnapshot): FirstLaunchViewModel {
  switch (snapshot.state) {
    case "booting":
    case "checking_existing_account":
      return {
        panel: "collapsed",
        character: "idle",
        title: "Teti",
        message: "Waking up",
        progress: { active: true, label: "Waking up" }
      };

    case "welcome":
      return {
        panel: "expanded",
        character: "wake",
        title: "Teti is here",
        message: "Give this Teti a name so it can settle into this Mac.",
        primaryAction: "Continue"
      };

    case "naming":
      return {
        panel: "expanded",
        character: "naming",
        title: "Name your Teti",
        message: "A short name works best in the island.",
        primaryAction: "Create Teti",
        input: {
          value: snapshot.nameInput,
          placeholder: "Name",
          disabled: false,
          error: snapshot.error?.kind === "invalid_name" ? snapshot.error.message : undefined
        }
      };

    case "creating_identity":
    case "registering_discovery":
      return {
        panel: "expanded",
        character: "thinking",
        title: "Creating Teti",
        message: phaseMessage(snapshot.phase),
        progress: {
          active: true,
          label: phaseLabel(snapshot.phase)
        },
        input: {
          value: snapshot.nameInput,
          placeholder: "Name",
          disabled: true
        }
      };

    case "ready":
      return {
        panel: "expanded",
        character: "ready",
        title: (snapshot.account?.displayName ?? snapshot.nameInput) || "Teti",
        message: "Ready to stay nearby on this Mac.",
        primaryAction: "Done",
        progress: {
          active: false,
          label: "Ready"
        }
      };

    case "idle":
      return {
        panel: "collapsed",
        character: "idle",
        title: snapshot.account?.displayName ?? "Teti",
        message: "Nearby"
      };

    case "recoverable_error":
      return {
        panel: "expanded",
        character: "error",
        title: "Teti needs a moment",
        message: snapshot.error?.message ?? "Teti could not finish yet.",
        primaryAction:
          snapshot.error?.kind === "discovery_registration_failure" ? "Try connecting again" : "Try again",
        input:
          snapshot.error?.kind === "invalid_name"
            ? {
                value: snapshot.nameInput,
                placeholder: "Name",
                disabled: false,
                error: snapshot.error.message
              }
            : undefined
      };

    case "fatal_error":
      return {
        panel: "expanded",
        character: "error",
        title: "Teti cannot continue safely",
        message: snapshot.error?.message ?? "Teti hit an internal setup problem."
      };
  }
}

function phaseLabel(phase: FirstLaunchSnapshot["phase"]): string {
  switch (phase) {
    case "preparing":
      return "Waking up";
    case "provisioning_chatmail":
      return "Creating my identity";
    case "persisting_account":
      return "Securing my place";
    case "registering_identity":
      return "Connecting";
    case "verifying_account":
      return "Checking my place";
    case "finalizing":
      return "Ready";
    default:
      return "Waking up";
  }
}

function phaseMessage(phase: FirstLaunchSnapshot["phase"]): string {
  switch (phase) {
    case "preparing":
      return "Waking up";
    case "provisioning_chatmail":
      return "Creating my identity";
    case "persisting_account":
      return "Securing my place on this Mac";
    case "registering_identity":
      return "Connecting";
    case "verifying_account":
      return "Checking my place";
    case "finalizing":
      return "Teti is ready.";
    default:
      return "Waking up";
  }
}
