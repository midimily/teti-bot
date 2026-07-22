const remoteTetiSilhouetteUrl = new URL(
  "../../assets/remote-teti-silhouette.png",
  import.meta.url
).href;

export type RemoteTetiReachability = "reachable" | "unreachable";

export interface RemoteTetiAvatarOptions {
  reachability: RemoteTetiReachability;
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
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}
