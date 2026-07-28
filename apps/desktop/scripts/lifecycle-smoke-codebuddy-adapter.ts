import {
  issueExecutionAuthority,
  type AgentConnector
} from "../../../core/callability/agent-core.ts";
import { TetiHostAgentKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import {
  probeCodeBuddyLogin,
  qualifyCodeBuddyConnector
} from "../../../integrations/agents/codebuddy/qualification.ts";

const qualification = await qualifyCodeBuddyConnector();
if (!qualification.connector || qualification.readiness.state !== "ready") {
  throw new Error(
    `CodeBuddy Connector is not ready: ${qualification.readiness.reasonCode ?? qualification.readiness.state}`
  );
}

const entrypoint = qualification.connector.fixedProcessEntrypoint;
const concurrentProbe = await Promise.all([
  probeCodeBuddyLogin(entrypoint),
  probeCodeBuddyLogin(entrypoint)
]);
if (concurrentProbe.some((state) => state !== "ready")) {
  throw new Error("Concurrent CodeBuddy local initialization did not remain ready.");
}

const cancelHost = new TetiHostAgentKernel({ connectors: [qualification.connector] });
try {
  const taskId = `codebuddy-cancel-${Date.now()}`;
  const request = task(taskId);
  const completion = cancelHost.execute(request, issueExecutionAuthority(request));
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (!cancelHost.cancel(taskId)) {
    throw new Error("CodeBuddy task could not be canceled while active.");
  }
  const canceled = await completion;
  if (canceled.state !== "canceled" || canceled.safeErrorCode !== "ADAPTER_CANCELED") {
    throw new Error(`Unexpected CodeBuddy cancellation result: ${canceled.state}.`);
  }
} finally {
  await cancelHost.shutdown();
}

const timeoutConnector: AgentConnector = {
  descriptor: {
    ...qualification.connector.descriptor,
    timeoutMs: 25
  },
  resourceBinding: qualification.connector.resourceBinding,
  fixedProcessEntrypoint: entrypoint,
  createExecutionSpec: (context) => qualification.connector!.createExecutionSpec(context),
  decodeArtifact: (stdout) => qualification.connector!.decodeArtifact(stdout),
  classifyFailure: (stdout) => qualification.connector!.classifyFailure(stdout)
};
const timeoutHost = new TetiHostAgentKernel({ connectors: [timeoutConnector] });
try {
  const request = task(`codebuddy-timeout-${Date.now()}`);
  const timedOut = await timeoutHost.execute(request, issueExecutionAuthority(request));
  if (timedOut.state !== "failed" || timedOut.safeErrorCode !== "ADAPTER_TIMEOUT") {
    throw new Error(`Unexpected CodeBuddy timeout result: ${timedOut.state}.`);
  }
} finally {
  await timeoutHost.shutdown();
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
