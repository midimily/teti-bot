export interface ProcessWritable {
  write(chunk: string): unknown;
  on(event: "error", listener: (error: Error & { code?: string }) => void): unknown;
}

/**
 * A broken parent pipe must never turn diagnostics into an uncaught-exception
 * write loop. Once a stream reports or throws an error, every later write is a
 * no-op and the caller can begin bounded shutdown.
 */
export class SafeProcessWriter {
  private readonly stream: ProcessWritable;
  private readonly onFailure: (error: unknown) => void;
  private failed = false;

  constructor(stream: ProcessWritable, onFailure: (error: unknown) => void = () => undefined) {
    this.stream = stream;
    this.onFailure = onFailure;
    this.stream.on("error", (error) => this.fail(error));
  }

  get isWritable(): boolean {
    return !this.failed;
  }

  write(text: string): boolean {
    if (this.failed) return false;
    try {
      this.stream.write(text);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    try {
      this.onFailure(error);
    } catch {
      // Output failure callbacks are diagnostic only and must never recurse.
    }
  }
}
