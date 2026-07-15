export const TETI_CHATMAIL_RELAY_DOMAIN = "TETI_CHATMAIL_RELAY_DOMAIN";
export const TETI_CHATMAIL_ACCOUNT_QR = "TETI_CHATMAIL_ACCOUNT_QR";
export const REQUIRED_REAL_VALIDATION_RELAY_DOMAIN = "mail.seep.im";
export const REQUIRED_REAL_VALIDATION_ADDRESS_SUFFIX = `@${REQUIRED_REAL_VALIDATION_RELAY_DOMAIN}`;

export interface ChatmailRelayConfig {
  relayDomain: string;
  accountQr: string;
  expectedAddressSuffix: string;
  explicitRelayDomain: boolean;
}

export interface ChatmailRelayConfigInput {
  relayDomain?: string;
  accountQr?: string;
}

export interface RelayValidationReport {
  ok: boolean;
  config: ChatmailRelayConfig;
  errors: string[];
}

export function resolveChatmailRelayConfig(
  input: ChatmailRelayConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): ChatmailRelayConfig {
  const rawDomain = input.relayDomain ?? env[TETI_CHATMAIL_RELAY_DOMAIN] ?? REQUIRED_REAL_VALIDATION_RELAY_DOMAIN;
  const relayDomain = normalizeRelayDomain(rawDomain);
  const accountQr = input.accountQr ?? env[TETI_CHATMAIL_ACCOUNT_QR] ?? accountQrFromRelayDomain(relayDomain);

  return {
    relayDomain,
    accountQr,
    expectedAddressSuffix: `@${relayDomain}`,
    explicitRelayDomain: Boolean(input.relayDomain ?? env[TETI_CHATMAIL_RELAY_DOMAIN])
  };
}

export function validateRealValidationRelayConfig(
  env: NodeJS.ProcessEnv = process.env
): RelayValidationReport {
  const errors: string[] = [];
  let config: ChatmailRelayConfig;

  try {
    config = resolveChatmailRelayConfig({}, env);
  } catch (error) {
    config = {
      relayDomain: "",
      accountQr: "",
      expectedAddressSuffix: "",
      explicitRelayDomain: false
    };
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, config, errors };
  }

  if (!config.explicitRelayDomain) {
    errors.push(`Set ${TETI_CHATMAIL_RELAY_DOMAIN}=${REQUIRED_REAL_VALIDATION_RELAY_DOMAIN}.`);
  }

  if (config.relayDomain !== REQUIRED_REAL_VALIDATION_RELAY_DOMAIN) {
    errors.push(`Real validation relay must be ${REQUIRED_REAL_VALIDATION_RELAY_DOMAIN}.`);
  }

  if (config.accountQr !== accountQrFromRelayDomain(REQUIRED_REAL_VALIDATION_RELAY_DOMAIN)) {
    errors.push("Real validation account QR must target dcaccount:mail.seep.im.");
  }

  return {
    ok: errors.length === 0,
    config,
    errors
  };
}

export function assertAddressMatchesRelay(address: string, expectedAddressSuffix: string): void {
  if (!address.toLowerCase().endsWith(expectedAddressSuffix.toLowerCase())) {
    throw new Error(`Chatmail address must end in ${expectedAddressSuffix}.`);
  }
}

export function accountQrFromRelayDomain(relayDomain: string): string {
  return `dcaccount:${normalizeRelayDomain(relayDomain)}`;
}

function normalizeRelayDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.includes("..") || normalized.startsWith(".") || normalized.endsWith(".")) {
    throw new Error("Chatmail relay domain is invalid.");
  }
  return normalized;
}
