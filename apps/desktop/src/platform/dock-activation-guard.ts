export const DOCK_ACTIVATION_COALESCE_MS = 350;
export const DOCK_ACTIVATION_FOCUS_GUARD_MS = 600;

export class DockActivationGuard {
  private readonly now: () => number;
  private lastActivationAt = Number.NEGATIVE_INFINITY;
  private ignoreFocusLossUntil = Number.NEGATIVE_INFINITY;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  begin(): boolean {
    const now = this.now();
    const isRepeatedActivation = now - this.lastActivationAt <= DOCK_ACTIVATION_COALESCE_MS;
    this.lastActivationAt = now;
    this.ignoreFocusLossUntil = Math.max(
      this.ignoreFocusLossUntil,
      now + DOCK_ACTIVATION_FOCUS_GUARD_MS
    );
    return !isRepeatedActivation;
  }

  shouldIgnoreFocusLoss(): boolean {
    return this.now() <= this.ignoreFocusLossUntil;
  }
}
