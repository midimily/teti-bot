import { CallableAdapterKernel } from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import { qualifyCodexCallableAdapter } from "../../../integrations/agents/codex/adapter.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_MARKER = "TETI_CODEX_ADAPTER_OK";
const imagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons", "32x32.png");
const qualification = await qualifyCodexCallableAdapter();
if (!qualification.adapter || qualification.readiness.state !== "ready") {
  throw new Error(`Codex Adapter is not ready: ${qualification.readiness.reasonCode ?? qualification.readiness.state}`);
}

const kernel = new CallableAdapterKernel({ adapters: [qualification.adapter] });
try {
  const result = await kernel.execute({
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
  });
  if (result.state !== "completed" || result.artifact?.text.trim() !== EXPECTED_MARKER) {
    throw new Error(`Codex Adapter smoke failed with ${result.safeErrorCode ?? result.state}.`);
  }
  console.log(JSON.stringify({
    ok: true,
    adapterId: qualification.readiness.adapterId,
    adapterRevision: qualification.readiness.adapterRevision,
    inputModes: qualification.adapter.descriptor.inputModes,
    artifact: EXPECTED_MARKER
  }));
} finally {
  await kernel.shutdown();
}
