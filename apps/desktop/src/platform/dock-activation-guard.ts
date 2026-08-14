export const DOCK_ACTIVATION_COALESCE_MS = 350;
export const DOCK_ACTIVATION_FOCUS_GUARD_MS = 600;

export type DockFocusLossDeferral =
  | { state: "inactive" }
  | { state: "scheduled"; delayMs: number }
  | { state: "pending"; delayMs: number };

export class DockActivationGuard {
  private readonly now: () => number;
  private lastActivationAt = Number.NEGATIVE_INFINITY;
  private ignoreFocusLossUntil = Number.NEGATIVE_INFINITY;
  private pendingFocusLoss = false;
  private pendingFocusLossRevision = 0;

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

  deferFocusLoss(
    schedule: (callback: () => void, delayMs: number) => unknown,
    onGuardExpired: () => void
  ): DockFocusLossDeferral {
    if (!this.shouldIgnoreFocusLoss()) return { state: "inactive" };
    const delayMs = this.remainingFocusGuardMs();
    if (this.pendingFocusLoss) return { state: "pending", delayMs };

    this.pendingFocusLoss = true;
    const revision = ++this.pendingFocusLossRevision;
    const settle = () => {
      if (!this.pendingFocusLoss || revision !== this.pendingFocusLossRevision) return;
      if (this.shouldIgnoreFocusLoss()) {
        schedule(settle, this.remainingFocusGuardMs());
        return;
      }
      this.pendingFocusLoss = false;
      onGuardExpired();
    };
    schedule(settle, delayMs);
    return { state: "scheduled", delayMs };
  }

  cancelPendingFocusLoss(): boolean {
    if (!this.pendingFocusLoss) return false;
    this.pendingFocusLoss = false;
    this.pendingFocusLossRevision += 1;
    return true;
  }

  private remainingFocusGuardMs(): number {
    return Math.max(1, Math.ceil(this.ignoreFocusLossUntil - this.now()) + 1);
  }
}
