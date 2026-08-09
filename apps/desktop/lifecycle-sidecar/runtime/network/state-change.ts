export type RuntimeNetworkStateChangeKind =
  | "profile"
  | "agent"
  | "capability"
  | "resource"
  | "share_policy"
  | "collaboration";

export interface RuntimeNetworkStateChangeEvent {
  kind: RuntimeNetworkStateChangeKind;
  observedAt: string;
}

/** Process-local change deduplicator. It never serializes its value to Network. */
export class RuntimeNetworkStateChangeDeduplicator {
  private readonly fingerprints = new Map<RuntimeNetworkStateChangeKind, string>();
  private readonly now: () => Date;
  private readonly onChange: (event: RuntimeNetworkStateChangeEvent) => void;

  constructor(options: {
    now?: () => Date;
    onChange?: (event: RuntimeNetworkStateChangeEvent) => void;
  } = {}) {
    this.now = options.now ?? (() => new Date());
    this.onChange = options.onChange ?? (() => undefined);
  }

  record(kind: RuntimeNetworkStateChangeKind, value: unknown): boolean {
    const fingerprint = JSON.stringify(value);
    if (this.fingerprints.get(kind) === fingerprint) return false;
    this.fingerprints.set(kind, fingerprint);
    try {
      this.onChange({ kind, observedAt: this.now().toISOString() });
    } catch {
      // Diagnostics never own Runtime state transitions.
    }
    return true;
  }
}
