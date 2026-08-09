import {
  BETA_035_NETWORK_REQUIREMENTS,
  type TetiNetworkBootstrap,
  type TetiNetworkCompatibilityRequirements
} from "./types.ts";
import { TetiNetworkClientError } from "./errors.ts";

export function assertTetiNetworkCompatible(
  bootstrap: TetiNetworkBootstrap,
  requirements: TetiNetworkCompatibilityRequirements = BETA_035_NETWORK_REQUIREMENTS
): void {
  if (bootstrap.protocolVersion !== requirements.requiredProtocolVersion) {
    throw incompatible(
      `Teti Network protocol ${bootstrap.protocolVersion} is incompatible with required protocol ${requirements.requiredProtocolVersion}.`
    );
  }
  if (bootstrap.contractRevision < requirements.minimumContractRevision) {
    throw incompatible(
      `Teti Network contract revision ${bootstrap.contractRevision} is older than required revision ${requirements.minimumContractRevision}.`
    );
  }
  const missing = requirements.requiredCapabilities.filter(
    (capability) => bootstrap.capabilities[capability] !== true
  );
  if (missing.length > 0) {
    throw incompatible(`Teti Network is missing required capabilities: ${missing.join(", ")}.`);
  }
}

function incompatible(message: string): TetiNetworkClientError {
  return new TetiNetworkClientError({
    code: "PROTOCOL_UNSUPPORTED",
    operation: "bootstrap",
    message,
    retryable: false
  });
}
