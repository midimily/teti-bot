import type { FirstLaunchSnapshot } from "./state-machine.ts";
import { TETI_DISPLAY_NAME_MAX_CHARACTERS } from "../../../../core/account/display-name.ts";

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
    maxCharacters?: number;
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
        title: "你好，主人。",
        message: "第一次见面，给我取个名字吧。",
        primaryAction: "下一步"
      };

    case "naming":
      return {
        panel: "expanded",
        character: "naming",
        title: "给我一个名字。",
        message: "短一点会更适合留海屏。",
        primaryAction: "创建",
        input: {
          value: snapshot.nameInput,
          placeholder: "名字",
          disabled: false,
          maxCharacters: TETI_DISPLAY_NAME_MAX_CHARACTERS,
          error: snapshot.error?.kind === "invalid_name" ? snapshot.error.message : undefined
        }
      };

    case "creating_identity":
    case "registering_discovery":
      return {
        panel: "expanded",
        character: "thinking",
        title: "正在创建 Teti",
        message: phaseMessage(snapshot.phase),
        progress: {
          active: true,
          label: phaseLabel(snapshot.phase)
        },
        input: {
          value: snapshot.nameInput,
          placeholder: "名字",
          disabled: true,
          maxCharacters: TETI_DISPLAY_NAME_MAX_CHARACTERS
        }
      };

    case "ready":
      return {
        panel: "expanded",
        character: "ready",
        title: (snapshot.account?.displayName ?? snapshot.nameInput) || "Teti",
        message: "我准备好了。",
        primaryAction: "完成",
        progress: {
          active: false,
          label: "就绪"
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
      const diagnosticCode = formatDiagnosticCode(snapshot.error?.diagnosticCode);
      return {
        panel: "expanded",
        character: "error",
        title: diagnosticCode ? `Teti 需要一点时间 [${diagnosticCode}]` : "Teti 需要一点时间",
        message: snapshot.error?.message ?? "Teti 暂时还没完成。",
        primaryAction:
          snapshot.error?.kind === "discovery_registration_failure" ? "再连接一次" : "再试一次",
        input:
          snapshot.error?.kind === "invalid_name"
            ? {
                value: snapshot.nameInput,
                placeholder: "名字",
                disabled: false,
                maxCharacters: TETI_DISPLAY_NAME_MAX_CHARACTERS,
                error: snapshot.error.message
              }
            : undefined
      };

    case "fatal_error":
      return {
        panel: "expanded",
        character: "error",
        title: "Teti 暂时不能继续",
        message: snapshot.error?.message ?? "Teti 遇到了内部设置问题。"
      };
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

function phaseLabel(phase: FirstLaunchSnapshot["phase"]): string {
  switch (phase) {
    case "preparing":
      return "正在醒来";
    case "provisioning_chatmail":
      return "正在创建身份";
    case "persisting_account":
      return "正在保存";
    case "registering_identity":
      return "正在连接";
    case "verifying_account":
      return "正在检查";
    case "finalizing":
      return "就绪";
    default:
      return "正在醒来";
  }
}

function phaseMessage(phase: FirstLaunchSnapshot["phase"]): string {
  switch (phase) {
    case "preparing":
      return "正在醒来";
    case "provisioning_chatmail":
      return "正在创建身份";
    case "persisting_account":
      return "正在这台 Mac 上保存";
    case "registering_identity":
      return "正在连接";
    case "verifying_account":
      return "正在检查";
    case "finalizing":
      return "Teti 准备好了。";
    default:
      return "正在醒来";
  }
}
