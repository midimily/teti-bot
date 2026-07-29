import { PassThrough } from "node:stream";
import type {
  ExecutionExit,
  ExecutionTransportHandle,
  ExecutionSpec,
  ExecutionTransport
} from "../../../../../../core/callability/agent-core.ts";

export interface FakeTransportResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export type FakeTransportScenario = (
  input: string,
  workspacePath: string
) => FakeTransportResult | Promise<FakeTransportResult>;

/** Deterministic in-memory backend for Host/Connector contract tests. */
export class FakeTransport implements ExecutionTransport {
  readonly kind = "fake" as const;
  private readonly scenarios: ReadonlyMap<string, FakeTransportScenario>;

  constructor(scenarios: ReadonlyMap<string, FakeTransportScenario>) {
    this.scenarios = scenarios;
  }

  start(input: { spec: ExecutionSpec; workspacePath: string | null }): ExecutionTransportHandle {
    if (input.spec.kind !== this.kind) {
      throw new Error("FakeTransport received a non-fake execution specification.");
    }
    const scenario = this.scenarios.get(input.spec.scenarioId);
    if (!scenario) throw new Error("FakeTransport scenario is not registered.");
    if (!input.workspacePath) throw new Error("FakeTransport requires a Host Workspace Snapshot.");
    return new FakeExecutionHandle(scenario, input.workspacePath);
  }
}

class FakeExecutionHandle implements ExecutionTransportHandle {
  readonly pid = undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly completion: Promise<ExecutionExit>;
  private readonly scenario: FakeTransportScenario;
  private readonly workspacePath: string;
  private resolveCompletion!: (exit: ExecutionExit) => void;
  private settled = false;

  constructor(scenario: FakeTransportScenario, workspacePath: string) {
    this.scenario = scenario;
    this.workspacePath = workspacePath;
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  writeInput(text: string): Promise<void> {
    if (this.settled) return Promise.resolve();
    void Promise.resolve(this.scenario(text, this.workspacePath)).then(
      (result) => {
        if (result.stdout) this.stdout.write(result.stdout);
        if (result.stderr) this.stderr.write(result.stderr);
        this.finish({ code: result.exitCode ?? 0, signal: null });
      },
      () => this.finish({ code: 1, signal: null })
    );
    return Promise.resolve();
  }

  terminate(_graceMs: number): Promise<void> {
    this.finish({ code: null, signal: "SIGTERM" });
    return Promise.resolve();
  }

  forceKill(): void {
    this.finish({ code: null, signal: "SIGKILL" });
  }

  private finish(exit: ExecutionExit): void {
    if (this.settled) return;
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    this.resolveCompletion(exit);
  }
}
