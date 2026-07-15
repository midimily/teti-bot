import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { resolveChatmailRelayConfig, type ChatmailRelayConfig } from "./relay-config.ts";

export interface ChatmailRelayDiagnostics {
  relayDomain: string;
  expectedAddressSuffix: string;
  accountConfigurationSource: string;
  dns: {
    ok: boolean;
    addresses: string[];
  };
  tls: {
    ok: boolean;
    authorized?: boolean;
    authorizationError?: string | null;
    protocol?: string;
    validTo?: string;
  };
  https: {
    ok: boolean;
    statusCode?: number;
    contentType?: string;
  };
  accountCreationEndpointChecked: false;
  errors: string[];
}

export async function inspectChatmailRelay(
  config: ChatmailRelayConfig = resolveChatmailRelayConfig()
): Promise<ChatmailRelayDiagnostics> {
  const errors: string[] = [];
  const diagnostics: ChatmailRelayDiagnostics = {
    relayDomain: config.relayDomain,
    expectedAddressSuffix: config.expectedAddressSuffix,
    accountConfigurationSource: config.accountQr,
    dns: {
      ok: false,
      addresses: []
    },
    tls: {
      ok: false
    },
    https: {
      ok: false
    },
    accountCreationEndpointChecked: false,
    errors
  };

  await inspectDns(diagnostics, errors);
  await inspectTls(diagnostics, errors);
  await inspectHttps(diagnostics, errors);

  return diagnostics;
}

async function inspectDns(diagnostics: ChatmailRelayDiagnostics, errors: string[]): Promise<void> {
  try {
    const records = await lookup(diagnostics.relayDomain, { all: true });
    diagnostics.dns.addresses = records.map((record) => record.address);
    diagnostics.dns.ok = diagnostics.dns.addresses.length > 0;
  } catch (error) {
    errors.push(`Relay DNS lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function inspectTls(diagnostics: ChatmailRelayDiagnostics, errors: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = tlsConnect({
      host: diagnostics.relayDomain,
      servername: diagnostics.relayDomain,
      port: 443,
      timeout: 5000
    });

    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      diagnostics.tls = {
        ok: socket.authorized,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        protocol: socket.getProtocol() ?? undefined,
        validTo: typeof certificate.valid_to === "string" ? certificate.valid_to : undefined
      };
      if (!socket.authorized) {
        errors.push(`Relay TLS certificate is not authorized: ${socket.authorizationError ?? "unknown"}`);
      }
      socket.end();
      resolve();
    });

    socket.once("timeout", () => {
      errors.push("Relay TLS connection timed out.");
      socket.destroy();
      resolve();
    });

    socket.once("error", (error) => {
      errors.push(`Relay TLS connection failed: ${error.message}`);
      resolve();
    });
  });
}

async function inspectHttps(diagnostics: ChatmailRelayDiagnostics, errors: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = httpsRequest(
      {
        host: diagnostics.relayDomain,
        path: "/",
        method: "HEAD",
        timeout: 5000
      },
      (response) => {
        diagnostics.https = {
          ok: Boolean(response.statusCode && response.statusCode < 500),
          statusCode: response.statusCode,
          contentType: Array.isArray(response.headers["content-type"])
            ? response.headers["content-type"].join(", ")
            : response.headers["content-type"]
        };
        if (!diagnostics.https.ok) {
          errors.push(`Relay HTTPS check returned status ${response.statusCode ?? "unknown"}.`);
        }
        response.resume();
        resolve();
      }
    );

    request.once("timeout", () => {
      errors.push("Relay HTTPS request timed out.");
      request.destroy();
      resolve();
    });

    request.once("error", (error) => {
      errors.push(`Relay HTTPS request failed: ${error.message}`);
      resolve();
    });

    request.end();
  });
}
