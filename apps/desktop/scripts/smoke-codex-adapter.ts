import { issueExecutionAuthority } from "../../../core/callability/agent-core.ts";
import type { CallableAdapterTaskRequest } from "../../../core/callability/adapter.ts";
import { TetiHostAgentKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import { qualifyCodexConnector } from "../../../integrations/agents/codex/adapter.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_MARKER = "TETI_CODEX_ADAPTER_OK";
const imagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons", "32x32.png");
const qualification = await qualifyCodexConnector();
if (!qualification.connector || qualification.readiness.state !== "ready") {
  throw new Error(`Codex Connector is not ready: ${qualification.readiness.reasonCode ?? qualification.readiness.state}`);
}

const hostAgent = new TetiHostAgentKernel({ connectors: [qualification.connector] });
try {
  const request: CallableAdapterTaskRequest = {
    schemaVersion: 2,
    taskId: `codex-smoke-${Date.now()}`,
    adapterId: "openai.codex.exec",
    agentId: "codex",
    capabilityId: "code-analysis",
    input: {
      kind: "parts",
      text: `A small Teti icon is attached only to validate bounded image input. Return exactly ${EXPECTED_MARKER}. Do not use tools and do not inspect other local files.`,
      images: [{
        attachmentId: "codex-smoke-image",
        mimeType: "image/png",
        path: imagePath
      }]
    },
    createdAt: new Date().toISOString()
  };
  const result = await hostAgent.execute(request, issueExecutionAuthority(request));
  if (result.state !== "completed" || result.artifact?.text.trim() !== EXPECTED_MARKER) {
    throw new Error(`Codex Connector smoke failed with ${result.safeErrorCode ?? result.state}.`);
  }
  console.log(JSON.stringify({
    ok: true,
    adapterId: qualification.readiness.adapterId,
    adapterRevision: qualification.readiness.adapterRevision,
    inputModes: qualification.connector.descriptor.inputModes,
    artifact: EXPECTED_MARKER
  }));
} finally {
  await hostAgent.shutdown();
}
