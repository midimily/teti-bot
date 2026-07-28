const remoteTetiSilhouetteUrl = new URL(
  "../../assets/remote-teti-silhouette.png",
  import.meta.url
).href;

export type RemoteTetiReachability = "reachable" | "checking" | "unreachable";

export interface RemoteTetiAvatarOptions {
  reachability: RemoteTetiReachability;
  label?: string;
  size?: number;
  className?: string;
}

export function createRemoteTetiAvatar(options: RemoteTetiAvatarOptions): HTMLElement {
  const avatar = document.createElement("span");
  avatar.className = `teti-remote-avatar is-${options.reachability}`;
  for (const className of options.className?.split(/\s+/).filter(Boolean) ?? []) {
    avatar.classList.add(className);
  }
  avatar.style.setProperty("--teti-remote-avatar-size", `${options.size ?? 28}px`);
  avatar.style.setProperty("--teti-remote-avatar-mask", `url("${remoteTetiSilhouetteUrl}")`);
  const label = options.label ?? defaultReachabilityLabel(options.reachability);
  avatar.setAttribute("role", "img");
  avatar.setAttribute("aria-label", `对方${label}`);
  avatar.title = label;

  const silhouette = document.createElement("span");
  silhouette.className = "teti-remote-avatar-silhouette";
  silhouette.setAttribute("aria-hidden", "true");
  avatar.append(silhouette);
  if (options.reachability === "checking") {
    const indicator = document.createElement("span");
    indicator.className = "teti-remote-avatar-indicator";
    indicator.setAttribute("aria-hidden", "true");
    avatar.append(indicator);
  }
  return avatar;
}

function defaultReachabilityLabel(reachability: RemoteTetiReachability): string {
  if (reachability === "reachable") return "在线";
  if (reachability === "checking") return "状态检测中";
  return "离线";
}
