import { CallableAdapterKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import { qualifyCodeBuddyCallableAdapter } from "../../../integrations/agents/codebuddy/qualification.ts";

const EXPECTED_MARKER = "TETI_CODEBUDDY_ADAPTER_OK";
const qualification = await qualifyCodeBuddyCallableAdapter();
if (!qualification.adapter || qualification.readiness.state !== "ready") {
  throw new Error(
    `CodeBuddy Adapter is not ready: ${qualification.readiness.reasonCode ?? qualification.readiness.state}`
  );
}

const kernel = new CallableAdapterKernel({ adapters: [qualification.adapter] });
try {
  const result = await kernel.execute({
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
  });
  if (result.state !== "completed" || result.artifact?.text.trim() !== EXPECTED_MARKER) {
    throw new Error(
      `CodeBuddy Adapter smoke failed with ${result.safeErrorCode ?? result.state}.`
    );
  }
  console.log(JSON.stringify({
    ok: true,
    adapterId: qualification.readiness.adapterId,
    adapterRevision: qualification.readiness.adapterRevision,
    artifact: EXPECTED_MARKER
  }));
} finally {
  await kernel.shutdown();
}
