export type CallableQualificationJob = (signal: AbortSignal) => Promise<void>;

export interface CallableQualificationSupervisorOptions {
  jobs: readonly CallableQualificationJob[];
  onJobError?: (input: { index: number; error: unknown }) => void;
}

/**
 * Runs slow, local Adapter qualification outside the lifecycle bootstrap path.
 * Every job is isolated and receives a shared abort signal for bounded shutdown.
 */
export class CallableQualificationSupervisor {
  private readonly jobs: readonly CallableQualificationJob[];
  private readonly onJobError: NonNullable<CallableQualificationSupervisorOptions["onJobError"]>;
  private readonly abortController = new AbortController();
  private completionPromise: Promise<void> | null = null;

  constructor(options: CallableQualificationSupervisorOptions) {
    this.jobs = [...options.jobs];
    this.onJobError = options.onJobError ?? (() => undefined);
  }

  start(): void {
    if (this.completionPromise || this.abortController.signal.aborted) return;
    this.completionPromise = Promise.allSettled(
      this.jobs.map(async (job, index) => {
        try {
          await job(this.abortController.signal);
        } catch (error) {
          if (!this.abortController.signal.aborted) this.onJobError({ index, error });
        }
      })
    ).then(() => undefined);
  }

  stop(): Promise<void> {
    this.abortController.abort();
    return this.completionPromise ?? Promise.resolve();
  }
}
