import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { join } from "node:path";
import {
  CallableAdapterContractError,
  CallableAdapterOutputError,
  validateCallableAdapterArtifactText,
  validateCallableAdapterTaskRequest,
  type CallableAdapterDecodedArtifact,
  type CallableAdapterImageInput,
  type CallableAdapterSafeErrorCode,
  type CallableAdapterTaskRequest,
  type CallableAdapterTaskSnapshot
} from "../../../../../core/callability/adapter.ts";
import {
  connectorDescriptorAsAdapterDescriptor,
  localChildAgentFromConnectors,
  validateAgentConnector,
  validateExecutionAuthority,
  validateExecutionSpec,
  type AgentConnector,
  type AgentConnectorDescriptor,
  type ExecutionAuthority,
  type ExecutionHandle,
  type ExecutionTransport,
  type LocalChildAgent,
  type TetiHostAgent,
  type TetiHostAgentTarget
} from "../../../../../core/callability/agent-core.ts";
import { CallableTaskStateMachine } from "../../../../../core/callability/task-machine.ts";
import {
  projectCallableAgent,
  type CallableAgent
} from "../../../../../core/callability/types.ts";
import { ProcessTransport } from "./transports/process.ts";
import type { TaskAttachmentStore } from "../tasks/attachments.ts";

export const TETI_HOST_AGENT_DEFAULTS = {
  maxConcurrentTasks: 4,
  maxRetainedTasks: 128
} as const;

export interface TetiHostAgentSnapshot {
  acceptingTasks: boolean;
  activeTaskCount: number;
  connectors: AgentConnectorDescriptor[];
  localChildAgents: LocalChildAgent[];
  callableAgents: CallableAgent[];
  tasks: CallableAdapterTaskSnapshot[];
}

export interface TetiHostAgentKernelOptions {
  connectors?: readonly AgentConnector[];
  transports?: readonly ExecutionTransport[];
  workspaceRoot?: string;
  maxConcurrentTasks?: number;
  maxRetainedTasks?: number;
  now?: () => Date;
  artifactImageStore?: Pick<TaskAttachmentStore, "ingestGeneratedImage">;
}

export class TetiHostAgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TetiHostAgentError";
    this.code = code;
  }
}

type TerminationReason = "cancel" | "timeout" | "output_limit" | "shutdown";

interface ExecutionControl {
  machine: CallableTaskStateMachine;
  process: ExecutionHandle | null;
  terminationReason: TerminationReason | null;
  termination: Deferred<TerminationReason>;
  completion: Promise<CallableAdapterTaskSnapshot>;
}

/**
 * Process-local Host Agent. It owns authorization, workspace isolation,
 * transports, output bounds, cancellation, and task state. Connectors cannot
 * access network collaboration services or peer identity through this API.
 */
export class TetiHostAgentKernel implements TetiHostAgent {
  private readonly connectors = new Map<string, AgentConnector>();
  private readonly callableAgents = new Map<string, CallableAgent>();
  private readonly tasks = new Map<string, CallableTaskStateMachine>();
  private readonly active = new Map<string, ExecutionControl>();
  private readonly transports = new Map<string, ExecutionTransport>();
  private readonly consumedAuthorities = new Map<string, number>();
  private readonly workspaceRoot: string;
  private readonly maxConcurrentTasks: number;
  private readonly maxRetainedTasks: number;
  private readonly now: () => Date;
  private readonly artifactImageStore?: Pick<TaskAttachmentStore, "ingestGeneratedImage">;
  private acceptingTasks = true;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: TetiHostAgentKernelOptions = {}) {
    for (const transport of options.transports ?? [new ProcessTransport()]) {
      if (this.transports.has(transport.kind)) {
        throw new TetiHostAgentError("HOST_TRANSPORT_DUPLICATE", `Duplicate Execution Transport: ${transport.kind}`);
      }
      this.transports.set(transport.kind, transport);
    }
    this.workspaceRoot = options.workspaceRoot ?? tmpdir();
    this.maxConcurrentTasks = positiveInteger(
      options.maxConcurrentTasks ?? TETI_HOST_AGENT_DEFAULTS.maxConcurrentTasks,
      "maxConcurrentTasks"
    );
    this.maxRetainedTasks = positiveInteger(
      options.maxRetainedTasks ?? TETI_HOST_AGENT_DEFAULTS.maxRetainedTasks,
      "maxRetainedTasks"
    );
    this.now = options.now ?? (() => new Date());
    this.artifactImageStore = options.artifactImageStore;

    for (const connector of options.connectors ?? []) this.registerConnector(connector);
  }

  get snapshot(): TetiHostAgentSnapshot {
    return {
      acceptingTasks: this.acceptingTasks,
      activeTaskCount: this.active.size,
      connectors: [...this.connectors.values()]
        .map((connector) => structuredClone(connector.descriptor))
        .sort((left, right) => left.connectorId.localeCompare(right.connectorId)),
      localChildAgents: this.getLocalChildAgents(),
      callableAgents: this.getCallableAgents(),
      tasks: [...this.tasks.values()].map((machine) => machine.snapshot)
    };
  }

  registerConnector(
    connector: AgentConnector,
    readyAt = this.now().toISOString()
  ): AgentConnectorDescriptor {
    if (!this.acceptingTasks) {
      throw new TetiHostAgentError(
        "HOST_AGENT_STOPPED",
        "Teti Host Agent is stopping."
      );
    }
    validateAgentConnector(connector);
    if (!this.transports.has(connector.descriptor.transportKind)) {
      throw new TetiHostAgentError(
        "HOST_TRANSPORT_UNAVAILABLE",
        `Execution Transport is unavailable: ${connector.descriptor.transportKind}`
      );
    }
    if (this.connectors.has(connector.descriptor.connectorId)) {
      throw new TetiHostAgentError(
        "CONNECTOR_DUPLICATE",
        `Duplicate Agent Connector ID: ${connector.descriptor.connectorId}`
      );
    }
    const callableAgent = projectCallableAgent({
      schemaVersion: 1,
      agentId: connector.descriptor.childAgentId,
      adapterId: connector.descriptor.connectorId,
      adapterRevision: connector.descriptor.connectorRevision,
      state: "ready",
      capabilityIds: [...connector.descriptor.capabilityIds],
      inputModes: [...connector.descriptor.inputModes],
      outputModes: [...connector.descriptor.outputModes],
      checkedAt: readyAt
    });
    if (!callableAgent) {
      throw new TetiHostAgentError(
        "CONNECTOR_CALLABILITY_INVALID",
        "Agent Connector could not be projected into a safe Passport identity."
      );
    }
    this.connectors.set(connector.descriptor.connectorId, connector);
    this.callableAgents.set(connector.descriptor.connectorId, callableAgent);
    return structuredClone(connector.descriptor);
  }

  getCallableAgents(): CallableAgent[] {
    return [...this.callableAgents.values()]
      .map((agent) => structuredClone(agent))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  getLocalChildAgents(): LocalChildAgent[] {
    const childAgentIds = [...new Set(
      [...this.connectors.values()].map((connector) => connector.descriptor.childAgentId)
    )].sort();
    return childAgentIds.map((childAgentId) => localChildAgentFromConnectors(
      childAgentId,
      [...this.connectors.values()].filter(
        (connector) => connector.descriptor.childAgentId === childAgentId
      )
    ));
  }

  resolveTarget(
    capabilityId: string,
    requiredInputModes: readonly ("text" | "image")[] = ["text"]
  ): TetiHostAgentTarget | null {
    const candidates = [...this.connectors.values()]
      .filter((connector) => connector.descriptor.capabilityIds.includes(capabilityId))
      .filter((connector) => {
        const modes = connector.descriptor.inputModes;
        return requiredInputModes.every((mode) => modes.includes(mode));
      })
      .sort((left, right) => left.descriptor.connectorId.localeCompare(right.descriptor.connectorId));
    const connector = candidates[0];
    return connector
      ? {
          connectorId: connector.descriptor.connectorId,
          childAgentId: connector.descriptor.childAgentId,
          capabilityId
        }
      : null;
  }

  getTask(taskId: string): CallableAdapterTaskSnapshot | null {
    return this.tasks.get(taskId)?.snapshot ?? null;
  }

  execute(
    request: CallableAdapterTaskRequest,
    authority: ExecutionAuthority
  ): Promise<CallableAdapterTaskSnapshot> {
    if (!this.acceptingTasks) {
      return Promise.reject(new TetiHostAgentError(
        "HOST_AGENT_STOPPED",
        "Teti Host Agent is stopping."
      ));
    }
    const connector = this.connectors.get(request.adapterId);
    if (!connector) {
      return Promise.reject(new TetiHostAgentError(
        "CONNECTOR_NOT_FOUND",
        "Agent Connector is not registered."
      ));
    }
    const adapterDescriptor = connectorDescriptorAsAdapterDescriptor(connector.descriptor);
    try {
      validateCallableAdapterTaskRequest(request, adapterDescriptor);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.tasks.has(request.taskId)) {
      return Promise.reject(new TetiHostAgentError(
        "HOST_TASK_DUPLICATE",
        "Host Agent task ID already exists."
      ));
    }
    if (this.active.size >= this.maxConcurrentTasks) {
      return Promise.reject(new TetiHostAgentError(
        "HOST_AGENT_BUSY",
        "Teti Host Agent has reached its local concurrency limit."
      ));
    }
    try {
      validateExecutionAuthority(authority, request, connector, this.now());
    } catch (error) {
      return Promise.reject(error);
    }
    const now = this.now().getTime();
    for (const [authorityId, expiresAt] of this.consumedAuthorities) {
      if (expiresAt < now) this.consumedAuthorities.delete(authorityId);
    }
    if (this.consumedAuthorities.has(authority.authorityId)) {
      return Promise.reject(new TetiHostAgentError(
        "EXECUTION_AUTHORITY_CONSUMED",
        "Execution Authority has already been consumed."
      ));
    }
    this.consumedAuthorities.set(authority.authorityId, Date.parse(authority.expiresAt));

    const machine = new CallableTaskStateMachine(request, this.now);
    this.tasks.set(request.taskId, machine);
    const control: ExecutionControl = {
      machine,
      process: null,
      terminationReason: null,
      termination: deferred<TerminationReason>(),
      completion: Promise.resolve(machine.snapshot)
    };
    control.completion = this.run(connector, request, control);
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
      // per-Connector cancellation grace. Never let that mismatch orphan a
      // detached Child Agent process group when the sidecar exits.
      control.process?.forceKill();
    }
    this.shutdownPromise = Promise.allSettled(
      [...this.active.values()].map((control) => control.completion)
    ).then(() => undefined);
    return this.shutdownPromise;
  }

  private async run(
    connector: AgentConnector,
    request: CallableAdapterTaskRequest,
    control: ExecutionControl
  ): Promise<CallableAdapterTaskSnapshot> {
    const descriptor = connector.descriptor;
    control.machine.start();
    const timeout = setTimeout(() => {
      this.requestTermination(control, "timeout", descriptor.connectorId);
    }, descriptor.timeoutMs);
    let workspacePath: string | null = null;
    let output: BoundedProcessOutput | null = null;

    try {
      workspacePath = await mkdtemp(join(this.workspaceRoot, "teti-agent-task-"));
      const images = await stageTaskImages(request, workspacePath);
      const launchOutcome = await Promise.race([
        Promise.resolve(connector.createExecutionSpec({
          taskId: request.taskId,
          capabilityId: request.capabilityId,
          workspacePath,
          images
        })).then(
          (spec) => ({ type: "spec" as const, spec }),
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
        validateExecutionSpec(launchOutcome.spec, connector);
        const transport = this.transports.get(connector.descriptor.transportKind);
        if (!transport) throw new Error("Execution Transport is unavailable.");
        control.process = transport.start({
          spec: launchOutcome.spec,
          workspacePath
        });
      } catch {
        return control.machine.fail("ADAPTER_LAUNCH_FAILED");
      }

      output = new BoundedProcessOutput(
        control.process,
        descriptor.maxOutputBytes,
        () => this.requestTermination(control, "output_limit", descriptor.connectorId)
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
            connector.classifyFailure?.(stdout) ?? "ADAPTER_EXIT_NONZERO"
          );
        } catch {
          return control.machine.fail("ADAPTER_EXIT_NONZERO");
        }
      }
      try {
        const artifact = connector.decodeArtifact?.(stdout, {
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
          connector,
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
    connector: AgentConnector,
    artifact: CallableAdapterDecodedArtifact
  ) {
    validateCallableAdapterArtifactText(artifact.text);
    if (!connector.descriptor.outputModes.includes("image")
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
    _connectorId: string
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
  private readonly process: ExecutionHandle;
  private readonly maxBytes: number;
  private readonly stdoutListener: (chunk: Buffer | string) => void;
  private readonly stderrListener: (chunk: Buffer | string) => void;
  private byteLength = 0;
  private exceeded = false;

  constructor(
    process: ExecutionHandle,
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
    if (this.exceeded) throw new Error("Child Agent output limit exceeded.");
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
    throw new TetiHostAgentError("HOST_AGENT_CONFIG", `${label} must be positive.`);
  }
  return value;
}
