export type TetiProvisioningMode = "mock" | "real";

export interface ProvisioningModeConfig {
  mode: TetiProvisioningMode;
  mockScenario: MockProvisioningScenario;
  delayMs: number;
}

export type MockProvisioningScenario =
  | "success"
  | "delayed_success"
  | "provisioning_failure"
  | "discovery_failure"
  | "persistence_failure";

export function readProvisioningMode(
  env: Record<string, string | undefined>,
  defaultMode: TetiProvisioningMode = "mock"
): ProvisioningModeConfig {
  const requestedMode = env.TETI_PROVISIONING_MODE ?? env.VITE_TETI_PROVISIONING_MODE ?? defaultMode;
  const mode: TetiProvisioningMode = requestedMode === "real" ? "real" : "mock";
  const scenario = normalizeMockScenario(
    env.TETI_MOCK_PROVISIONING_SCENARIO ?? env.VITE_TETI_MOCK_PROVISIONING_SCENARIO
  );
  const delayMs = normalizeDelay(env.TETI_MOCK_PROVISIONING_DELAY_MS ?? env.VITE_TETI_MOCK_PROVISIONING_DELAY_MS);

  return {
    mode,
    mockScenario: scenario,
    delayMs
  };
}

function normalizeMockScenario(value: string | undefined): MockProvisioningScenario {
  switch (value) {
    case "delayed_success":
    case "provisioning_failure":
    case "discovery_failure":
    case "persistence_failure":
      return value;
    default:
      return "success";
  }
}

function normalizeDelay(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 450;
}
