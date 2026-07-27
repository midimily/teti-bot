import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { join } from "node:path";
import {
  CallableAdapterContractError,
  CallableAdapterOutputError,
  callableAdapterInputModes,
  callableAdapterOutputModes,
  validateCallableAdapterArtifactText,
  validateCallableAdapterDescriptor,
  validateCallableAdapterLaunchSpec,
  validateCallableAdapterTaskRequest,
  type CallableAdapter,
  type CallableAdapterDecodedArtifact,
  type CallableAdapterDescriptor,
  type CallableAdapterImageInput,
  type CallableAdapterSafeErrorCode,
  type CallableAdapterTaskRequest,
  type CallableAdapterTaskSnapshot
} from "../../../../../core/callability/adapter.ts";
import { CallableTaskStateMachine } from "../../../../../core/callability/task-machine.ts";
import {
  projectCallableAgent,
  type CallableAgent
} from "../../../../../core/callability/types.ts";
import {
  NodeAdapterProcessSpawner,
  type AdapterProcessSpawner,
  type ManagedAdapterProcess
} from "./process-runner.ts";
import type { TaskAttachmentStore } from "../tasks/attachments.ts";

export const CALLABLE_ADAPTER_KERNEL_DEFAULTS = {
  maxConcurrentTasks: 4,
  maxRetainedTasks: 128
} as const;

export interface CallableAdapterKernelSnapshot {
  acceptingTasks: boolean;
  activeTaskCount: number;
  adapters: CallableAdapterDescriptor[];
  callableAgents: CallableAgent[];
  tasks: CallableAdapterTaskSnapshot[];
}

export interface CallableAdapterTarget {
  adapterId: string;
  agentId: string;
  capabilityId: string;
}

export interface CallableAdapterKernelOptions {
  adapters?: readonly CallableAdapter[];
  processSpawner?: AdapterProcessSpawner;
  workspaceRoot?: string;
  maxConcurrentTasks?: number;
  maxRetainedTasks?: number;
  now?: () => Date;
  artifactImageStore?: Pick<TaskAttachmentStore, "ingestGeneratedImage">;
}

export class CallableAdapterKernelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CallableAdapterKernelError";
    this.code = code;
  }
}

type TerminationReason = "cancel" | "timeout" | "output_limit" | "shutdown";

interface ExecutionControl {
  machine: CallableTaskStateMachine;
  process: ManagedAdapterProcess | null;
  terminationReason: TerminationReason | null;
  termination: Deferred<TerminationReason>;
  completion: Promise<CallableAdapterTaskSnapshot>;
}

/**
 * Process-local execution kernel. It has no Lifecycle task method, remote task
 * endpoint, or Chatmail execution path. Beta 0.1.10 exposes only its bounded
 * readiness metadata to Callable Passport.
 */
export class CallableAdapterKernel {
  private readonly adapters = new Map<string, CallableAdapter>();
  private readonly callableAgents = new Map<string, CallableAgent>();
  private readonly tasks = new Map<string, CallableTaskStateMachine>();
  private readonly active = new Map<string, ExecutionControl>();
  private readonly processSpawner: AdapterProcessSpawner;
  private readonly workspaceRoot: string;
  private readonly maxConcurrentTasks: number;
  private readonly maxRetainedTasks: number;
  private readonly now: () => Date;
  private readonly artifactImageStore?: Pick<TaskAttachmentStore, "ingestGeneratedImage">;
  private acceptingTasks = true;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: CallableAdapterKernelOptions = {}) {
    this.processSpawner = options.processSpawner ?? new NodeAdapterProcessSpawner();
    this.workspaceRoot = options.workspaceRoot ?? tmpdir();
    this.maxConcurrentTasks = positiveInteger(
      options.maxConcurrentTasks ?? CALLABLE_ADAPTER_KERNEL_DEFAULTS.maxConcurrentTasks,
      "maxConcurrentTasks"
    );
    this.maxRetainedTasks = positiveInteger(
      options.maxRetainedTasks ?? CALLABLE_ADAPTER_KERNEL_DEFAULTS.maxRetainedTasks,
      "maxRetainedTasks"
    );
    this.now = options.now ?? (() => new Date());
    this.artifactImageStore = options.artifactImageStore;

    for (const adapter of options.adapters ?? []) this.registerAdapter(adapter);
  }

  get snapshot(): CallableAdapterKernelSnapshot {
    return {
      acceptingTasks: this.acceptingTasks,
      activeTaskCount: this.active.size,
      adapters: [...this.adapters.values()]
        .map((adapter) => structuredClone(adapter.descriptor))
        .sort((left, right) => left.adapterId.localeCompare(right.adapterId)),
      callableAgents: this.getCallableAgents(),
      tasks: [...this.tasks.values()].map((machine) => machine.snapshot)
    };
  }

  registerAdapter(adapter: CallableAdapter, readyAt = this.now().toISOString()): CallableAdapterDescriptor {
    if (!this.acceptingTasks) {
      throw new CallableAdapterKernelError(
        "ADAPTER_KERNEL_STOPPED",
        "Callable Adapter Kernel is stopping."
      );
    }
    validateCallableAdapterDescriptor(adapter.descriptor);
    validateCallableAdapterLaunchSpec({ executable: adapter.entrypoint, args: [] });
    if (this.adapters.has(adapter.descriptor.adapterId)) {
      throw new CallableAdapterKernelError(
        "ADAPTER_DUPLICATE",
        `Duplicate Callable Adapter ID: ${adapter.descriptor.adapterId}`
      );
    }
    const callableAgent = projectCallableAgent({
      schemaVersion: 1,
      agentId: adapter.descriptor.agentId,
      adapterId: adapter.descriptor.adapterId,
      adapterRevision: adapter.descriptor.adapterRevision,
      state: "ready",
      capabilityIds: [...adapter.descriptor.capabilityIds],
      inputModes: callableAdapterInputModes(adapter.descriptor),
      outputModes: callableAdapterOutputModes(adapter.descriptor),
      checkedAt: readyAt
    });
    if (!callableAgent) {
      throw new CallableAdapterKernelError(
        "ADAPTER_CALLABILITY_INVALID",
        "Callable Adapter could not be projected into a safe Passport identity."
      );
    }
    this.adapters.set(adapter.descriptor.adapterId, adapter);
    this.callableAgents.set(adapter.descriptor.adapterId, callableAgent);
    return structuredClone(adapter.descriptor);
  }

  getCallableAgents(): CallableAgent[] {
    return [...this.callableAgents.values()]
      .map((agent) => structuredClone(agent))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  resolveTarget(
    capabilityId: string,
    requiredInputModes: readonly ("text" | "image")[] = ["text"]
  ): CallableAdapterTarget | null {
    const candidates = [...this.adapters.values()]
      .filter((adapter) => adapter.descriptor.capabilityIds.includes(capabilityId))
      .filter((adapter) => {
        const modes = callableAdapterInputModes(adapter.descriptor);
        return requiredInputModes.every((mode) => modes.includes(mode));
      })
      .sort((left, right) => left.descriptor.adapterId.localeCompare(right.descriptor.adapterId));
    const adapter = candidates[0];
    return adapter
      ? {
          adapterId: adapter.descriptor.adapterId,
          agentId: adapter.descriptor.agentId,
          capabilityId
        }
      : null;
  }

  getTask(taskId: string): CallableAdapterTaskSnapshot | null {
    return this.tasks.get(taskId)?.snapshot ?? null;
  }

  execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    if (!this.acceptingTasks) {
      return Promise.reject(new CallableAdapterKernelError(
        "ADAPTER_KERNEL_STOPPED",
        "Callable Adapter Kernel is stopping."
      ));
    }
    const adapter = this.adapters.get(request.adapterId);
    if (!adapter) {
      return Promise.reject(new CallableAdapterKernelError(
        "ADAPTER_NOT_FOUND",
        "Callable Adapter is not registered."
      ));
    }
    validateCallableAdapterTaskRequest(request, adapter.descriptor);
    if (this.tasks.has(request.taskId)) {
      return Promise.reject(new CallableAdapterKernelError(
        "ADAPTER_TASK_DUPLICATE",
        "Callable Adapter task ID already exists."
      ));
    }
    if (this.active.size >= this.maxConcurrentTasks) {
      return Promise.reject(new CallableAdapterKernelError(
        "ADAPTER_KERNEL_BUSY",
        "Callable Adapter Kernel has reached its local concurrency limit."
      ));
    }

    const machine = new CallableTaskStateMachine(request, this.now);
    this.tasks.set(request.taskId, machine);
    const control: ExecutionControl = {
      machine,
      process: null,
      terminationReason: null,
      termination: deferred<TerminationReason>(),
      completion: Promise.resolve(machine.snapshot)
    };
    control.completion = this.run(adapter, request, control);
    this.active.set(request.taskId, control);
    return control.completion;
  }

  cancel(taskId: string): boolean {
    const control = this.active.get(taskId);
    if (!control || control.machine.isTerminal) return false;
    this.requestTermination(control, "cancel", control.machine.snapshot.adapterId);
    return true;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.acceptingTasks = false;
    for (const control of this.active.values()) {
      this.requestTermination(control, "shutdown", control.machine.snapshot.adapterId);
      // Runtime shutdown has a shorter global deadline than the maximum
      // per-Adapter cancellation grace. Never let that mismatch orphan a
      // detached Adapter process group when the sidecar exits.
      control.process?.forceKill();
    }
    this.shutdownPromise = Promise.allSettled(
      [...this.active.values()].map((control) => control.completion)
    ).then(() => undefined);
    return this.shutdownPromise;
  }

  private async run(
    adapter: CallableAdapter,
    request: CallableAdapterTaskRequest,
    control: ExecutionControl
  ): Promise<CallableAdapterTaskSnapshot> {
    const descriptor = adapter.descriptor;
    control.machine.start();
    const timeout = setTimeout(() => {
      this.requestTermination(control, "timeout", descriptor.adapterId);
    }, descriptor.timeoutMs);
    let workspacePath: string | null = null;
    let output: BoundedProcessOutput | null = null;

    try {
      workspacePath = await mkdtemp(join(this.workspaceRoot, "teti-agent-task-"));
      const images = await stageTaskImages(request, workspacePath);
      const launchOutcome = await Promise.race([
        Promise.resolve(adapter.createLaunchSpec({
          taskId: request.taskId,
          capabilityId: request.capabilityId,
          workspacePath,
          images
        })).then(
          (launch) => ({ type: "launch" as const, launch }),
          () => ({ type: "prepare_error" as const })
        ),
        control.termination.promise.then((reason) => ({ type: "terminated" as const, reason }))
      ]);

      if (launchOutcome.type === "terminated") {
        return this.finishTermination(control, launchOutcome.reason);
      }
      if (launchOutcome.type === "prepare_error") {
        return control.machine.fail("ADAPTER_PREPARE_FAILED");
      }

      try {
        validateCallableAdapterLaunchSpec(launchOutcome.launch, adapter.entrypoint);
        control.process = this.processSpawner.spawn({
          launch: launchOutcome.launch,
          workspacePath
        });
      } catch {
        return control.machine.fail("ADAPTER_LAUNCH_FAILED");
      }

      output = new BoundedProcessOutput(
        control.process,
        descriptor.maxOutputBytes,
        () => this.requestTermination(control, "output_limit", descriptor.adapterId)
      );
      await control.process.writeInput(request.input.text);

      const processOutcome = await Promise.race([
        control.process.completion.then(
          (exit) => ({ type: "exit" as const, exit }),
          () => ({ type: "process_error" as const })
        ),
        control.termination.promise.then(async (reason) => {
          await control.process!.terminate(descriptor.cancelGraceMs);
          return { type: "terminated" as const, reason };
        })
      ]);

      if (processOutcome.type === "terminated") {
        return this.finishTermination(control, processOutcome.reason);
      }
      if (processOutcome.type === "process_error") {
        return control.machine.fail("ADAPTER_LAUNCH_FAILED");
      }
      if (control.terminationReason) {
        return this.finishTermination(control, control.terminationReason);
      }
      let stdout: string;
      try {
        stdout = output.readStdout();
      } catch {
        return control.machine.fail("ADAPTER_OUTPUT_INVALID");
      }
      if (processOutcome.exit.code !== 0) {
        try {
          return control.machine.fail(
            adapter.classifyFailure?.(stdout) ?? "ADAPTER_EXIT_NONZERO"
          );
        } catch {
          return control.machine.fail("ADAPTER_EXIT_NONZERO");
        }
      }
      try {
        const artifact = adapter.decodeArtifact?.(stdout, {
          taskId: request.taskId,
          capabilityId: request.capabilityId,
          workspacePath,
          images
        }) ?? stdout;
        if (typeof artifact === "string") {
          validateCallableAdapterArtifactText(artifact);
          return control.machine.complete(artifact);
        }
        return control.machine.complete(await this.persistImageArtifact(
          request.taskId,
          workspacePath,
          adapter,
          artifact
        ));
      } catch (error) {
        return control.machine.fail(
          error instanceof CallableAdapterOutputError
            ? error.safeErrorCode
            : "ADAPTER_OUTPUT_INVALID"
        );
      }
    } catch (error) {
      if (control.terminationReason && !control.machine.isTerminal) {
        return this.finishTermination(control, control.terminationReason);
      }
      if (!control.machine.isTerminal) {
        const code: CallableAdapterSafeErrorCode = error instanceof CallableAdapterContractError
          ? "ADAPTER_PREPARE_FAILED"
          : "ADAPTER_INTERNAL_ERROR";
        return control.machine.fail(code);
      }
      return control.machine.snapshot;
    } finally {
      clearTimeout(timeout);
      output?.dispose();
      if (control.process) {
        await control.process.terminate(descriptor.cancelGraceMs).catch(() => undefined);
      }
      if (workspacePath) {
        await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
      }
      this.active.delete(request.taskId);
      this.pruneHistory();
    }
  }

  private async persistImageArtifact(
    taskId: string,
    workspacePath: string,
    adapter: CallableAdapter,
    artifact: CallableAdapterDecodedArtifact
  ) {
    validateCallableAdapterArtifactText(artifact.text);
    if (!callableAdapterOutputModes(adapter.descriptor).includes("image")
      || artifact.images.length === 0
      || artifact.images.length > 4
      || !this.artifactImageStore) {
      throw new CallableAdapterOutputError("ADAPTER_OUTPUT_INVALID", "Image Artifact output is unavailable.");
    }
    const images = [];
    for (const output of artifact.images) {
      if (!await isWorkspaceOutputPath(workspacePath, output.path)) {
        throw new CallableAdapterOutputError("ADAPTER_OUTPUT_INVALID", "Image Artifact path is outside the task workspace.");
      }
      images.push((await this.artifactImageStore.ingestGeneratedImage(taskId, output.path)).part);
    }
    return { kind: "parts" as const, text: artifact.text, images };
  }

  private requestTermination(
    control: ExecutionControl,
    reason: TerminationReason,
    _adapterId: string
  ): void {
    if (control.terminationReason || control.machine.isTerminal) return;
    control.terminationReason = reason;
    control.termination.resolve(reason);
  }

  private finishTermination(
    control: ExecutionControl,
    reason: TerminationReason
  ): CallableAdapterTaskSnapshot {
    if (control.machine.isTerminal) return control.machine.snapshot;
    switch (reason) {
      case "cancel":
        return control.machine.cancel("ADAPTER_CANCELED");
      case "shutdown":
        return control.machine.cancel("ADAPTER_RUNTIME_SHUTDOWN");
      case "timeout":
        return control.machine.fail("ADAPTER_TIMEOUT");
      case "output_limit":
        return control.machine.fail("ADAPTER_OUTPUT_LIMIT");
    }
  }

  private pruneHistory(): void {
    if (this.tasks.size <= this.maxRetainedTasks) return;
    for (const [taskId, machine] of this.tasks) {
      if (this.tasks.size <= this.maxRetainedTasks) break;
      if (machine.isTerminal && !this.active.has(taskId)) this.tasks.delete(taskId);
    }
  }
}

async function isWorkspaceOutputPath(workspacePath: string, outputPath: string): Promise<boolean> {
  if (typeof outputPath !== "string" || !isAbsolute(outputPath) || outputPath.includes("\0")) return false;
  const path = resolve(await realpath(outputPath));
  const workspace = resolve(await realpath(workspacePath));
  const child = relative(workspace, path);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

async function stageTaskImages(
  request: CallableAdapterTaskRequest,
  workspacePath: string
): Promise<CallableAdapterImageInput[]> {
  const staged: CallableAdapterImageInput[] = [];
  for (const [index, image] of (request.input.images ?? []).entries()) {
    const extension = image.mimeType === "image/png" ? ".png" : ".jpg";
    const path = join(workspacePath, `input-image-${index + 1}${extension}`);
    await copyFile(image.path, path);
    await chmod(path, 0o600);
    staged.push({
      attachmentId: image.attachmentId,
      mimeType: image.mimeType,
      path
    });
  }
  return staged;
}

class BoundedProcessOutput {
  private readonly stdoutChunks: Buffer[] = [];
  private readonly process: ManagedAdapterProcess;
  private readonly maxBytes: number;
  private readonly stdoutListener: (chunk: Buffer | string) => void;
  private readonly stderrListener: (chunk: Buffer | string) => void;
  private byteLength = 0;
  private exceeded = false;

  constructor(
    process: ManagedAdapterProcess,
    maxBytes: number,
    onLimit: () => void
  ) {
    this.process = process;
    this.maxBytes = maxBytes;
    this.stdoutListener = (chunk) => this.accept(chunk, true, onLimit);
    this.stderrListener = (chunk) => this.accept(chunk, false, onLimit);
    process.stdout.on("data", this.stdoutListener);
    process.stderr.on("data", this.stderrListener);
  }

  readStdout(): string {
    if (this.exceeded) throw new Error("Callable Adapter output limit exceeded.");
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.stdoutChunks));
  }

  dispose(): void {
    this.process.stdout.off("data", this.stdoutListener);
    this.process.stderr.off("data", this.stderrListener);
  }

  private accept(chunk: Buffer | string, stdout: boolean, onLimit: () => void): void {
    if (this.exceeded) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.byteLength += buffer.byteLength;
    if (this.byteLength > this.maxBytes) {
      this.exceeded = true;
      this.stdoutChunks.length = 0;
      onLimit();
      return;
    }
    if (stdout) this.stdoutChunks.push(buffer);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CallableAdapterKernelError("ADAPTER_KERNEL_CONFIG", `${label} must be positive.`);
  }
  return value;
}
