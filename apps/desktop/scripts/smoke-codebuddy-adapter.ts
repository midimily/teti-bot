import { issueExecutionAuthority } from "../../../core/callability/agent-core.ts";
import { TetiHostAgentKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import { qualifyCodeBuddyConnector } from "../../../integrations/agents/codebuddy/qualification.ts";

const EXPECTED_MARKER = "TETI_CODEBUDDY_ADAPTER_OK";
const qualification = await qualifyCodeBuddyConnector();
if (!qualification.connector || qualification.readiness.state !== "ready") {
  throw new Error(
    `CodeBuddy Connector is not ready: ${qualification.readiness.reasonCode ?? qualification.readiness.state}`
  );
}

const hostAgent = new TetiHostAgentKernel({ connectors: [qualification.connector] });
try {
  const request = {
    schemaVersion: 1,
    taskId: `codebuddy-smoke-${Date.now()}`,
    adapterId: "tencent.codebuddy.code",
    agentId: "codebuddy",
    capabilityId: "code-analysis",
    input: {
      kind: "text",
      text: `Return exactly ${EXPECTED_MARKER}. Do not use tools and do not inspect local files.`
    },
    createdAt: new Date().toISOString()
  } as const;
  const result = await hostAgent.execute(request, issueExecutionAuthority(request));
  if (result.state !== "completed" || result.artifact?.text.trim() !== EXPECTED_MARKER) {
    throw new Error(
      `CodeBuddy Connector smoke failed with ${result.safeErrorCode ?? result.state}.`
    );
  }
  console.log(JSON.stringify({
    ok: true,
    adapterId: qualification.readiness.adapterId,
    adapterRevision: qualification.readiness.adapterRevision,
    artifact: EXPECTED_MARKER
  }));
} finally {
  await hostAgent.shutdown();
}
