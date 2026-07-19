import type { PeerConnectionDto } from "../lifecycle-bridge/protocol.ts";

const remoteTetiSilhouetteUrl = new URL(
  "../../assets/remote-teti-silhouette.png",
  import.meta.url
).href;

export const REMOTE_TETI_HEARTBEAT_FRESH_MS = 15_000;

export type RemoteTetiReachability = "reachable" | "unreachable";

export interface RemoteTetiAvatarOptions {
  reachability: RemoteTetiReachability;
  size?: number;
  className?: string;
}

export function mapRemoteTetiReachability(
  connection: PeerConnectionDto,
  now = Date.now()
): RemoteTetiReachability {
  if (connection.state !== "Confirmed" || !connection.lastHeartbeatReceivedAt) {
    return "unreachable";
  }
  return now - Date.parse(connection.lastHeartbeatReceivedAt) < REMOTE_TETI_HEARTBEAT_FRESH_MS
    ? "reachable"
    : "unreachable";
}

export function remoteTetiReachabilityLabel(reachability: RemoteTetiReachability): "在线" | "离线" {
  return reachability === "reachable" ? "在线" : "离线";
}

export function createRemoteTetiAvatar(options: RemoteTetiAvatarOptions): HTMLElement {
  const avatar = document.createElement("span");
  avatar.className = `teti-remote-avatar is-${options.reachability}`;
  for (const className of options.className?.split(/\s+/).filter(Boolean) ?? []) {
    avatar.classList.add(className);
  }
  avatar.style.setProperty("--teti-remote-avatar-size", `${options.size ?? 28}px`);
  avatar.style.setProperty("--teti-remote-avatar-mask", `url("${remoteTetiSilhouetteUrl}")`);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}
