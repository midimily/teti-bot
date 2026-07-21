export type TetiRuntimeHostState = "stopped" | "running" | "stopping";
export type TetiRuntimeJobState = "idle" | "scheduled" | "running";

export interface TetiRuntimeScheduledJob {
  id: string;
  intervalMs: number;
  runOnStart?: boolean;
  shouldRun?: () => boolean | Promise<boolean>;
  run: () => void | Promise<void>;
}

export interface TetiRuntimeJobSnapshot {
  id: string;
  state: TetiRuntimeJobState;
  lastStartedAt?: string;
  lastSkippedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
}

export interface TetiRuntimeHostSnapshot {
  state: TetiRuntimeHostState;
  jobs: TetiRuntimeJobSnapshot[];
}

export interface TetiRuntimeHostOptions {
  jobs?: readonly TetiRuntimeScheduledJob[];
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => Date;
  onJobError?: (input: { jobId: string; error: unknown }) => void;
}

/**
 * Process-local lifecycle and scheduling owner for the existing Node sidecar.
 * Task 1 introduced the isolated skeleton; Task 2 connects the characterized
 * Registry, Chatmail, and Codex background jobs.
 */
export class TetiRuntimeHost {
  private readonly jobs: readonly TetiRuntimeScheduledJob[];
  private readonly jobsById: ReadonlyMap<string, TetiRuntimeScheduledJob>;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly now: () => Date;
  private readonly onJobError: NonNullable<TetiRuntimeHostOptions["onJobError"]>;
  private readonly timers = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly jobSnapshots = new Map<string, TetiRuntimeJobSnapshot>();
  private stateValue: TetiRuntimeHostState = "stopped";
  private generation = 0;
  private stopPromise: Promise<void> | null = null;

  constructor(options: TetiRuntimeHostOptions = {}) {
    this.jobs = [...(options.jobs ?? [])];
    validateJobs(this.jobs);
    this.jobsById = new Map(this.jobs.map((job) => [job.id, job]));
    this.schedule = options.schedule ?? defaultSchedule;
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = options.now ?? (() => new Date());
    this.onJobError = options.onJobError ?? (() => undefined);
    for (const job of this.jobs) {
      this.jobSnapshots.set(job.id, { id: job.id, state: "idle" });
    }
  }

  get isRunning(): boolean {
    return this.stateValue === "running";
  }

  get snapshot(): TetiRuntimeHostSnapshot {
    return {
      state: this.stateValue,
      jobs: this.jobs.map((job) => ({ ...this.jobSnapshots.get(job.id)! }))
    };
  }

  start(): void {
    if (this.stateValue === "running") return;
    if (this.stateValue === "stopping") {
      throw new Error("Teti Runtime cannot start while it is stopping.");
    }

    this.stateValue = "running";
    const generation = ++this.generation;
    for (const job of this.jobs) {
      if (job.runOnStart) {
        void this.execute(job, generation);
      } else {
        this.scheduleNext(job, generation);
      }
    }
  }

  /**
   * Requests an immediate run without allowing overlap. Task 2 can use this
   * after first-account creation instead of waiting for a normal interval.
   */
  runNow(jobId: string): boolean {
    if (this.stateValue !== "running") return false;
    const job = this.jobsById.get(jobId);
    if (!job) throw new Error(`Unknown Teti Runtime job: ${jobId}`);
    if (this.inFlight.has(jobId)) return false;

    this.cancelScheduled(jobId);
    void this.execute(job, this.generation);
    return true;
  }

  stop(): Promise<void> {
    if (this.stateValue === "stopped") return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;

    this.stateValue = "stopping";
    this.generation += 1;
    for (const jobId of this.timers.keys()) this.cancelScheduled(jobId);

    const inFlight = [...this.inFlight.values()];
    this.stopPromise = Promise.allSettled(inFlight).then(() => {
      for (const snapshot of this.jobSnapshots.values()) snapshot.state = "idle";
      this.stateValue = "stopped";
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private scheduleNext(job: TetiRuntimeScheduledJob, generation: number): void {
    if (this.stateValue !== "running" || generation !== this.generation) return;
    const handle = this.schedule(() => {
      this.timers.delete(job.id);
      void this.execute(job, generation);
    }, job.intervalMs);
    this.timers.set(job.id, handle);
    this.updateJobSnapshot(job.id, { state: "scheduled" });
  }

  private async execute(job: TetiRuntimeScheduledJob, generation: number): Promise<void> {
    if (this.stateValue !== "running" || generation !== this.generation || this.inFlight.has(job.id)) return;

    const execution = this.runJob(job, generation);
    this.inFlight.set(job.id, execution);
    await execution.finally(() => {
      if (this.inFlight.get(job.id) === execution) this.inFlight.delete(job.id);
    });
  }

  private async runJob(job: TetiRuntimeScheduledJob, generation: number): Promise<void> {
    this.updateJobSnapshot(job.id, {
      state: "running",
      lastStartedAt: this.now().toISOString()
    });
    try {
      if ((await job.shouldRun?.()) === false) {
        this.updateJobSnapshot(job.id, { lastSkippedAt: this.now().toISOString() });
        return;
      }
      await job.run();
      this.updateJobSnapshot(job.id, { lastSucceededAt: this.now().toISOString() });
    } catch (error) {
      this.updateJobSnapshot(job.id, { lastFailedAt: this.now().toISOString() });
      try {
        this.onJobError({ jobId: job.id, error });
      } catch {
        // Diagnostic hooks never own or interrupt Runtime scheduling.
      }
    } finally {
      if (this.stateValue === "running" && generation === this.generation) {
        this.scheduleNext(job, generation);
      } else {
        this.updateJobSnapshot(job.id, { state: "idle" });
      }
    }
  }

  private cancelScheduled(jobId: string): void {
    if (!this.timers.has(jobId)) return;
    this.cancel(this.timers.get(jobId));
    this.timers.delete(jobId);
    this.updateJobSnapshot(jobId, { state: "idle" });
  }

  private updateJobSnapshot(jobId: string, update: Partial<TetiRuntimeJobSnapshot>): void {
    const current = this.jobSnapshots.get(jobId);
    if (!current) return;
    Object.assign(current, update);
  }
}

function validateJobs(jobs: readonly TetiRuntimeScheduledJob[]): void {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (!job.id.trim() || job.id.length > 64) {
      throw new Error("Teti Runtime job IDs must contain 1 to 64 characters.");
    }
    if (ids.has(job.id)) throw new Error(`Duplicate Teti Runtime job ID: ${job.id}`);
    ids.add(job.id);
    if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0) {
      throw new Error(`Teti Runtime job ${job.id} must use a positive interval.`);
    }
  }
}

function defaultSchedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return handle;
}
