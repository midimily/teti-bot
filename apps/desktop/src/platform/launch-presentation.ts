import type { FirstLaunchSnapshot } from "../first-launch/state-machine.ts";
import type { DesktopPlatformInfo } from "./contract.ts";

export const WINDOWS_LAUNCH_FOCUS_GUARD_MS = 3_000;

/**
 * A Windows companion has no Dock/menu-bar affordance that makes the collapsed
 * island discoverable. Reveal the main panel when an existing profile launches;
 * macOS keeps its native notch-panel startup behaviour.
 */
export function shouldRevealMainPanelOnLaunch(
  platform: DesktopPlatformInfo,
  snapshot: FirstLaunchSnapshot
): boolean {
  return platform.platform === "windows"
    && platform.shell === "top-center-companion"
    && snapshot.state === "idle"
    && Boolean(snapshot.account);
}

export function isWindowsLaunchFocusGuardActive(
  deadline: number,
  now = Date.now()
): boolean {
  return now <= deadline;
}
