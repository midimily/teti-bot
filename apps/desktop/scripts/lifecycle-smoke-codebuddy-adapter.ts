import type { CallableAdapter } from "../../../core/callability/adapter.ts";
import { CallableAdapterKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import {
  probeCodeBuddyLogin,
  qualifyCodeBuddyCallableAdapter
} from "../../../integrations/agents/codebuddy/qualification.ts";

const qualification = await qualifyCodeBuddyCallableAdapter();
if (!qualification.adapter || qualification.readiness.state !== "ready") {
  throw new Error(
    `CodeBuddy Adapter is not ready: ${qualification.readiness.reasonCode ?? qualification.readiness.state}`
  );
}

const entrypoint = qualification.adapter.entrypoint;
const concurrentProbe = await Promise.all([
  probeCodeBuddyLogin(entrypoint),
  probeCodeBuddyLogin(entrypoint)
]);
if (concurrentProbe.some((state) => state !== "ready")) {
  throw new Error("Concurrent CodeBuddy local initialization did not remain ready.");
}

const cancelKernel = new CallableAdapterKernel({ adapters: [qualification.adapter] });
try {
  const taskId = `codebuddy-cancel-${Date.now()}`;
  const completion = cancelKernel.execute(task(taskId));
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (!cancelKernel.cancel(taskId)) {
    throw new Error("CodeBuddy task could not be canceled while active.");
  }
  const canceled = await completion;
  if (canceled.state !== "canceled" || canceled.safeErrorCode !== "ADAPTER_CANCELED") {
    throw new Error(`Unexpected CodeBuddy cancellation result: ${canceled.state}.`);
  }
} finally {
  await cancelKernel.shutdown();
}

const timeoutAdapter: CallableAdapter = {
  descriptor: {
    ...qualification.adapter.descriptor,
    timeoutMs: 25
  },
  entrypoint,
  createLaunchSpec: (context) => qualification.adapter!.createLaunchSpec(context),
  decodeArtifact: (stdout) => qualification.adapter!.decodeArtifact(stdout),
  classifyFailure: (stdout) => qualification.adapter!.classifyFailure(stdout)
};
const timeoutKernel = new CallableAdapterKernel({ adapters: [timeoutAdapter] });
try {
  const timedOut = await timeoutKernel.execute(task(`codebuddy-timeout-${Date.now()}`));
  if (timedOut.state !== "failed" || timedOut.safeErrorCode !== "ADAPTER_TIMEOUT") {
    throw new Error(`Unexpected CodeBuddy timeout result: ${timedOut.state}.`);
  }
} finally {
  await timeoutKernel.shutdown();
}

console.log(JSON.stringify({
  ok: true,
  adapterId: qualification.readiness.adapterId,
  concurrentInitialization: true,
  cancellation: "ADAPTER_CANCELED",
  timeout: "ADAPTER_TIMEOUT"
}));

function task(taskId: string) {
  return {
    schemaVersion: 1 as const,
    taskId,
    adapterId: "tencent.codebuddy.code",
    agentId: "codebuddy",
    capabilityId: "code-analysis",
    input: {
      kind: "text" as const,
      text: "Return a short analysis without using tools."
    },
    createdAt: new Date().toISOString()
  };
}
