import { randomUUID } from "node:crypto";
import { resolveTetiNetworkBaseUrl } from "./config.ts";
import {
  createCanonicalTetiNetworkRequest,
  createTetiNetworkNonce,
  pendingTetiNetworkKeyId,
  requireEd25519PublicKey,
  requireTetiNetworkNonce,
  sha256Base64Url
} from "./signing.ts";
import {
  TetiNetworkClientError,
  type TetiNetworkErrorCode,
  type TetiNetworkOperation
} from "./errors.ts";
import {
  TETI_NETWORK_CAPABILITIES,
  TETI_NETWORK_PROTOCOL_VERSION,
  type TetiNetworkAdoptIdentityRequest,
  type TetiNetworkAuthenticatedSigner,
  type TetiNetworkBootstrap,
  type TetiNetworkCapabilities,
  type TetiNetworkClient,
  type TetiNetworkClientInstanceDocument,
  type TetiNetworkEnrollClientInstanceRequest,
  type TetiNetworkIdentitySession,
  type TetiNetworkPublicCapabilitySummary,
  type TetiNetworkPublicCapabilitySummaryWrite,
  type TetiNetworkPublicDirectoryPage,
  type TetiNetworkPublicDirectoryQuery,
  type TetiNetworkPublicDirectorySort,
  type TetiNetworkPublicNode,
  type TetiNetworkPublicNodeSummary,
  type TetiNetworkPublicProfile,
  type TetiNetworkPublicProfileDocument,
  type TetiNetworkProfileEtag,
  type TetiNetworkProfileResult,
  type TetiNetworkProfileWriteOptions,
  type TetiNetworkPublicStats,
  type TetiNetworkPresenceMode,
  type TetiNetworkPresencePolicy,
  type TetiNetworkPresenceReadResponse,
  type TetiNetworkPresenceReportRequest,
  type TetiNetworkPresenceReportResponse,
  type TetiNetworkRegisterIdentityRequest,
  type TetiNetworkRelationshipCommand,
  type TetiNetworkRelationshipDocument,
  type TetiNetworkRelationshipEtag,
  type TetiNetworkRelationshipListPage,
  type TetiNetworkRelationshipListQuery,
  type TetiNetworkRelationshipResult,
  type TetiNetworkRelationshipState,
  type TetiNetworkRelationshipWriteOptions,
  type TetiNetworkRequestRelationshipRequest,
  type TetiNetworkMutateRelationshipRequest,
  type TetiNetworkReplacePublicProfileRequest,
  type TetiNetworkReleasePolicy,
  type TetiNetworkSigningKey,
  type TetiNetworkWriteOptions
} from "./types.ts";

export const DEFAULT_TETI_NETWORK_TIMEOUT_MS = 5_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_VERSION_PATTERN = /^[A-Za-z0-9.+_-]{1,64}$/;
const CLIENT_PLATFORM_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const TETI_PUBLIC_ID_PATTERN = /^teti_[a-z0-9]{9}$/;
const TETI_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CLIENT_INSTANCE_ID_PATTERN = /^ci_[A-Za-z0-9_-]{22}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const PROFILE_ETAG_PATTERN = /^"profile-r(?:0|[1-9]\d*)"$/;
const RELATIONSHIP_ID_PATTERN = /^rel_[A-Za-z0-9_-]{21}[AQgw]$/;
const RELATIONSHIP_ETAG_PATTERN = /^"relationship-r(?:0|[1-9]\d*)"$/;
const RELATIONSHIP_STATES = new Set<TetiNetworkRelationshipState>([
  "requested",
  "confirmed",
  "rejected",
  "blocked",
  "revoked"
]);
const PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLIC_PLATFORMS = new Set(["macos", "windows", "linux", "ios", "android", "other"]);
const DELIVERY_DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PUBLIC_DIRECTORY_SORTS = new Set<TetiNetworkPublicDirectorySort>([
  "updated_desc",
  "created_asc",
  "id_asc"
]);

interface NetworkErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
  requestId: string;
}

export interface HttpTetiNetworkClientOptions {
  baseUrl?: string;
  clientVersion: string;
  clientPlatform: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  requestIdFactory?: () => string;
  nonceFactory?: () => string;
  now?: () => Date;
}

export class HttpTetiNetworkClient implements TetiNetworkClient {
  private readonly baseUrl: string;
  private readonly clientVersion: string;
  private readonly clientPlatform: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly requestIdFactory: () => string;
  private readonly nonceFactory: () => string;
  private readonly now: () => Date;
  private serverClockOffsetMs = 0;

  constructor(options: HttpTetiNetworkClientOptions) {
    this.baseUrl = resolveTetiNetworkBaseUrl({
      TETI_NETWORK_BASE_URL: options.baseUrl ?? resolveTetiNetworkBaseUrl()
    });
    if (!CLIENT_VERSION_PATTERN.test(options.clientVersion)) {
      throw new Error("Teti Network client version is invalid.");
    }
    if (!CLIENT_PLATFORM_PATTERN.test(options.clientPlatform)) {
      throw new Error("Teti Network client platform is invalid.");
    }
    this.clientVersion = options.clientVersion;
    this.clientPlatform = options.clientPlatform;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TETI_NETWORK_TIMEOUT_MS;
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.nonceFactory = options.nonceFactory ?? createTetiNetworkNonce;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Teti Network timeout must be positive.");
    }
  }

  async getBootstrap(signal?: AbortSignal): Promise<TetiNetworkBootstrap> {
    const bootstrap = await this.read("bootstrap", "/v1/bootstrap", parseBootstrap, signal);
    this.serverClockOffsetMs = Date.parse(bootstrap.serverTime) - this.now().getTime();
    return bootstrap;
  }

  async getPublicNode(tetiId: string, signal?: AbortSignal): Promise<TetiNetworkPublicNode> {
    const canonicalId = requirePublicTetiId(tetiId, "public_node", "request");
    return this.read(
      "public_node",
      `/v1/public/nodes/${encodeURIComponent(canonicalId)}`,
      (body) => parsePublicNode(body, "public_node"),
      signal
    );
  }

  async listPublicNodes(
    query: TetiNetworkPublicDirectoryQuery = {},
    signal?: AbortSignal
  ): Promise<TetiNetworkPublicDirectoryPage> {
    const search = publicDirectoryQuery(query);
    return this.read(
      "public_directory",
      `/v1/public/nodes${search ? `?${search}` : ""}`,
      parsePublicDirectory,
      signal
    );
  }

  async getPublicStats(signal?: AbortSignal): Promise<TetiNetworkPublicStats> {
    return this.read("public_stats", "/v1/public/stats", parsePublicStats, signal);
  }

  async registerIdentity(
    input: TetiNetworkRegisterIdentityRequest,
    pendingClient: TetiNetworkSigningKey,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkIdentitySession> {
    return this.signedJsonWrite(
      "identity_register",
      "/v1/identity/register",
      input,
      { principalId: pendingTetiNetworkKeyId(pendingClient.publicKey), pendingClient },
      options,
      parseIdentitySession
    );
  }

  async adoptIdentity(
    input: TetiNetworkAdoptIdentityRequest,
    pendingClient: TetiNetworkSigningKey,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkIdentitySession> {
    return this.signedJsonWrite(
      "identity_adopt",
      "/v1/identity/adopt",
      input,
      { principalId: pendingTetiNetworkKeyId(pendingClient.publicKey), pendingClient },
      options,
      parseIdentitySession
    );
  }

  async getIdentitySelf(
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkIdentitySession> {
    return this.signedRead(
      "identity_self",
      "/v1/identity/self",
      authentication,
      signal,
      parseIdentitySession
    );
  }

  async getProfileSelf(
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkProfileResult> {
    return this.signedProfileRead(authentication, signal);
  }

  async replaceProfileSelf(
    input: TetiNetworkReplacePublicProfileRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkProfileWriteOptions
  ): Promise<TetiNetworkProfileResult> {
    const operation = "profile_replace" as const;
    if (!CLIENT_INSTANCE_ID_PATTERN.test(authentication.clientInstanceId)) {
      throw invalidRequest(operation, "Teti Network client instance ID is invalid.");
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)) {
      throw invalidRequest(operation, "Teti Network idempotency key is invalid.");
    }
    const request = requireProfileReplacementRequest(input);
    const expectedEtag = profileEtag(request.expectedRevision);
    if (!PROFILE_ETAG_PATTERN.test(options.ifMatch) || options.ifMatch !== expectedEtag) {
      throw invalidRequest(operation, "Teti Network Profile If-Match does not match expectedRevision.");
    }
    const rawBody = options.rawBody ?? JSON.stringify(request);
    if (options.rawBody !== undefined) assertPersistedBody(operation, request, options.rawBody);
    const path = "/v1/profile/self";
    const headers = this.signedHeaders({
      operation,
      method: "PUT",
      path,
      principalId: authentication.clientInstanceId,
      signingKey: authentication.signingKey,
      rawBody,
      idempotencyKey: options.idempotencyKey
    });
    headers["If-Match"] = options.ifMatch;
    const response = await this.fetchResponse(operation, path, {
      method: "PUT",
      headers,
      body: rawBody
    }, options.signal);
    const body = await readJson(response, operation);
    validateContractHeaders(response, body, operation);
    if (!response.ok) throw errorFromResponse(response, body, operation);
    if (response.status !== 200) {
      throw invalidResponse(operation, "Teti Network returned an invalid Profile write status.", response);
    }
    return parseProfileResult(response, body, operation);
  }

  async enrollClientInstance(
    input: TetiNetworkEnrollClientInstanceRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkClientInstanceDocument> {
    return this.signedJsonWrite(
      "client_enroll",
      "/v1/client-instances/enroll",
      input,
      { principalId: authentication.clientInstanceId, pendingClient: authentication.signingKey },
      options,
      parseClientInstanceMutation
    );
  }

  async revokeClientInstance(
    clientInstanceId: string,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkClientInstanceDocument> {
    if (!CLIENT_INSTANCE_ID_PATTERN.test(clientInstanceId)) {
      throw invalidRequest("client_revoke", "Teti Network client instance ID is invalid.");
    }
    return this.signedJsonWrite(
      "client_revoke",
      `/v1/client-instances/${encodeURIComponent(clientInstanceId)}/revoke`,
      { schemaVersion: 1 },
      { principalId: authentication.clientInstanceId, pendingClient: authentication.signingKey },
      options,
      parseClientInstanceMutation
    );
  }

  async reportPresence(
    input: TetiNetworkPresenceReportRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkPresenceReportResponse> {
    const rawBody = JSON.stringify(requirePresenceReportRequest(input));
    return this.signedJsonEphemeralWrite(
      "presence_report",
      "/v1/presence/self",
      rawBody,
      authentication,
      signal,
      parsePresenceReport
    );
  }

  async getPresence(
    tetiId: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkPresenceReadResponse> {
    const canonicalId = requirePublicTetiId(tetiId, "presence_read", "request");
    return this.signedRead(
      "presence_read",
      `/v1/presence/${encodeURIComponent(canonicalId)}`,
      authentication,
      signal,
      parsePresenceRead
    );
  }

  async listRelationships(
    query: TetiNetworkRelationshipListQuery = {},
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipListPage> {
    const search = relationshipListQuery(query);
    return this.signedRead(
      "relationship_list",
      `/v1/relationships${search ? `?${search}` : ""}`,
      authentication,
      signal,
      parseRelationshipList
    );
  }

  async getRelationship(
    relationshipId: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult> {
    const id = requireRelationshipId(relationshipId, "relationship_get", "request");
    return this.signedRelationshipRead(
      "relationship_get",
      `/v1/relationships/${encodeURIComponent(id)}`,
      authentication,
      signal
    );
  }

  async getRelationshipWithPeer(
    peerTetiId: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult> {
    const peer = requirePublicTetiId(peerTetiId, "relationship_get_by_peer", "request");
    return this.signedRelationshipRead(
      "relationship_get_by_peer",
      `/v1/relationships/with/${encodeURIComponent(peer)}`,
      authentication,
      signal
    );
  }

  async requestRelationship(
    input: TetiNetworkRequestRelationshipRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult> {
    const request = requireRelationshipRequest(input);
    return this.signedRelationshipWrite(
      "relationship_request",
      "/v1/relationships/request",
      request,
      authentication,
      options,
      true
    );
  }

  async mutateRelationship(
    relationshipId: string,
    command: TetiNetworkRelationshipCommand,
    input: TetiNetworkMutateRelationshipRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult> {
    const operation = relationshipCommandOperation(command);
    const id = requireRelationshipId(relationshipId, operation, "request");
    const request = requireRelationshipMutation(input, operation);
    return this.signedRelationshipWrite(
      operation,
      `/v1/relationships/${encodeURIComponent(id)}/${command}`,
      request,
      authentication,
      options,
      false
    );
  }

  private async read<T>(
    operation: TetiNetworkOperation,
    path: string,
    parse: (body: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await this.request(operation, path, signal);
    const body = await readJson(response, operation);
    validateContractHeaders(response, body, operation);
    if (!response.ok) throw errorFromResponse(response, body, operation);
    return parse(body);
  }

  private async request(
    operation: TetiNetworkOperation,
    path: string,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    return this.fetchResponse(operation, path, {
      method: "GET",
      headers: {
        accept: "application/json",
        "Teti-Protocol-Version": String(TETI_NETWORK_PROTOCOL_VERSION),
        "Teti-Client-Version": this.clientVersion,
        "Teti-Client-Platform": this.clientPlatform,
        "Teti-Client-Request-ID": this.requestIdFactory()
      }
    }, callerSignal);
  }

  private async signedRead<T>(
    operation: TetiNetworkOperation,
    path: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal: AbortSignal | undefined,
    parse: (body: unknown, operation: TetiNetworkOperation) => T
  ): Promise<T> {
    if (!CLIENT_INSTANCE_ID_PATTERN.test(authentication.clientInstanceId)) {
      throw invalidRequest(operation, "Teti Network client instance ID is invalid.");
    }
    const headers = this.signedHeaders({
      operation,
      method: "GET",
      path,
      principalId: authentication.clientInstanceId,
      signingKey: authentication.signingKey,
      rawBody: "",
      idempotencyKey: ""
    });
    const response = await this.fetchResponse(operation, path, { method: "GET", headers }, signal);
    const body = await readJson(response, operation);
    validateContractHeaders(response, body, operation);
    if (!response.ok) throw errorFromResponse(response, body, operation);
    return parse(body, operation);
  }

  private async signedProfileRead(
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkProfileResult> {
    const operation = "profile_self" as const;
    if (!CLIENT_INSTANCE_ID_PATTERN.test(authentication.clientInstanceId)) {
      throw invalidRequest(operation, "Teti Network client instance ID is invalid.");
    }
    const path = "/v1/profile/self";
    const headers = this.signedHeaders({
      operation,
      method: "GET",
      path,
      principalId: authentication.clientInstanceId,
      signingKey: authentication.signingKey,
      rawBody: "",
      idempotencyKey: ""
    });
    const response = await this.fetchResponse(operation, path, { method: "GET", headers }, signal);
    const body = await readJson(response, operation);
    validateContractHeaders(response, body, operation);
    if (!response.ok) throw errorFromResponse(response, body, operation);
    return parseProfileResult(response, body, operation);
  }

  private async signedRelationshipRead(
    operation: "relationship_get" | "relationship_get_by_peer",
    path: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult> {
    if (!CLIENT_INSTANCE_ID_PATTERN.test(authentication.clientInstanceId)) {
      throw invalidRequest(operation, "Teti Network client instance ID is invalid.");
    }
    const headers = this.signedHeaders({
      operation,
      method: "GET",
      path,
      principalId: authentication.clientInstanceId,
      signingKey: authentication.signingKey,
      rawBody: "",
      idempotencyKey: ""
    });
    const response = await this.fetchResponse(operation, path, { method: "GET", headers }, signal);
    const body = await readJson(response, operation);
    validateContractHeaders(response, body, operation);
    if (!response.ok) throw errorFromResponse(response, body, operation);
    return parseRelationshipResult(response, body, operation);
  }

  private async signedRelationshipWrite(
    operation:
      | "relationship_request"
      | "relationship_accept"
      | "relationship_reject"
      | "relationship_block"
      | "relationship_revoke",
    path: string,
    input: TetiNetworkRequestRelationshipRequest | TetiNetworkMutateRelationshipRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions,
    allowCreated: boolean
  ): Promise<TetiNetworkRelationshipResult> {
    if (!CLIENT_INSTANCE_ID_PATTERN.test(authentication.clientInstanceId)) {
      throw invalidRequest(operation, "Teti Network client instance ID is invalid.");
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)) {
      throw invalidRequest(operation, "Teti Network idempotency key is invalid.");
    }
    const expectedEtag = relationshipEtag(input.expectedRevision);
    if (!RELATIONSHIP_ETAG_PATTERN.test(options.ifMatch) || options.ifMatch !== expectedEtag) {
      throw invalidRequest(operation, "Teti Network Relationship If-Match does not match expectedRevision.");
    }
    const rawBody = options.rawBody ?? JSON.stringify(input);
    if (options.rawBody !== undefined) assertPersistedBody(operation, input, options.rawBody);
    const headers = this.signedHeaders({
      operation,
      method: "POST",
      path,
      principalId: authentication.clientInstanceId,
      signingKey: authentication.signingKey,
      rawBody,
      idempotencyKey: options.idempotencyKey
    });
    headers["If-Match"] = options.ifMatch;
    const response = await this.fetchResponse(operation, path, {
      method: "POST",
      headers,
      body: rawBody
    }, options.signal);
    const body = await readJson(response, operation);
    validateContractHeaders(response, body, operation);
    if (!response.ok) throw errorFromResponse(response, body, operation);
    if (response.status !== 200 && !(allowCreated && response.status === 201)) {
      throw invalidResponse(operation, "Teti Network returned an invalid Relationship write status.", response);
    }
    return parseRelationshipResult(response, body, operation);
  }

  private async signedJsonWrite<T>(
    operation: TetiNetworkOperation,
    path: string,
    input: unknown,
    authentication: { principalId: string; pendingClient: TetiNetworkSigningKey },
    options: TetiNetworkWriteOptions,
    parse: (body: unknown, operation: TetiNetworkOperation) => T
  ): Promise<T> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)) {
      throw invalidRequest(operation, "Teti Network idempotency key is invalid.");
    }
    const rawBody = options.rawBody ?? JSON.stringify(input);
    if (options.rawBody !== undefined) assertPersistedBody(operation, input, options.rawBody);
    const headers = this.signedHeaders({
      operation,
      method: "POST",
      path,
      principalId: authentication.principalId,
      signingKey: authentication.pendingClient,
      rawBody,
      idempotencyKey: options.idempotencyKey
    });
    const response = await this.fetchResponse(operation, path, {
      method: "POST",
      headers,
      body: rawBody
    }, options.signal);
    const body = await readJson(response, operation);
    validateContractHeaders(response, body, operation);
    if (!response.ok) throw errorFromResponse(response, body, operation);
    if (response.status !== 200 && response.status !== 201) {
      throw invalidResponse(operation, "Teti Network returned an invalid write status.", response);
    }
    return parse(body, operation);
  }

  private async signedJsonEphemeralWrite<T>(
    operation: TetiNetworkOperation,
    path: string,
    rawBody: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal: AbortSignal | undefined,
    parse: (body: unknown, operation: TetiNetworkOperation) => T
  ): Promise<T> {
    if (!CLIENT_INSTANCE_ID_PATTERN.test(authentication.clientInstanceId)) {
      throw invalidRequest(operation, "Teti Network client instance ID is invalid.");
    }
    const headers = this.signedHeaders({
      operation,
      method: "PUT",
      path,
      principalId: authentication.clientInstanceId,
      signingKey: authentication.signingKey,
      rawBody,
      idempotencyKey: ""
    });
    const response = await this.fetchResponse(operation, path, {
      method: "PUT",
      headers,
      body: rawBody
    }, signal);
    const body = await readJson(response, operation);
    validateContractHeaders(response, body, operation);
    if (!response.ok) throw errorFromResponse(response, body, operation);
    if (response.status !== 200) {
      throw invalidResponse(operation, "Teti Network returned an invalid Presence status.", response);
    }
    return parse(body, operation);
  }

  private signedHeaders(input: {
    operation: TetiNetworkOperation;
    method: "GET" | "POST" | "PUT";
    path: string;
    principalId: string;
    signingKey: TetiNetworkSigningKey;
    rawBody: string;
    idempotencyKey: string;
  }): Record<string, string> {
    const clientRequestId = this.requestIdFactory();
    if (!UUID_PATTERN.test(clientRequestId)) {
      throw invalidRequest(input.operation, "Teti Network signed request ID must be a UUID.");
    }
    const timestamp = new Date(this.now().getTime() + this.serverClockOffsetMs).toISOString();
    let nonce: string;
    try {
      nonce = requireTetiNetworkNonce(this.nonceFactory());
    } catch {
      throw invalidRequest(input.operation, "Teti Network authentication nonce is invalid.");
    }
    const bodySha256 = sha256Base64Url(Buffer.from(input.rawBody, "utf8"));
    const canonical = createCanonicalTetiNetworkRequest({
      method: input.method,
      exactPathAndQuery: input.path,
      protocolVersion: TETI_NETWORK_PROTOCOL_VERSION,
      clientRequestId,
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      timestamp,
      nonce,
      bodySha256
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      "Teti-Protocol-Version": String(TETI_NETWORK_PROTOCOL_VERSION),
      "Teti-Client-Version": this.clientVersion,
      "Teti-Client-Platform": this.clientPlatform,
      "Teti-Client-Request-ID": clientRequestId,
      "Teti-Auth-Timestamp": timestamp,
      "Teti-Auth-Nonce": nonce,
      "Teti-Content-SHA256": bodySha256,
      "Teti-Signature": input.signingKey.sign(canonical)
    };
    if (input.principalId.startsWith("sha256:")) {
      headers["Teti-Pending-Key-ID"] = input.principalId;
    } else {
      headers["Teti-Client-Instance-ID"] = input.principalId;
    }
    if (input.idempotencyKey) headers["Teti-Idempotency-Key"] = input.idempotencyKey;
    if (input.method === "POST" || input.method === "PUT") {
      headers["content-type"] = "application/json";
    }
    return headers;
  }

  private async fetchResponse(
    operation: TetiNetworkOperation,
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abortFromCaller = () => controller.abort();
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    if (callerSignal?.aborted) controller.abort();

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal
      });
    } catch {
      if (timedOut) {
        throw new TetiNetworkClientError({
          code: "NETWORK_TIMEOUT",
          operation,
          message: "Teti Network request timed out.",
          retryable: true
        });
      }
      throw new TetiNetworkClientError({
        code: "NETWORK_UNAVAILABLE",
        operation,
        message: callerSignal?.aborted
          ? "Teti Network request was cancelled."
          : "Teti Network is temporarily unavailable.",
        retryable: !callerSignal?.aborted
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

async function readJson(response: Response, operation: TetiNetworkOperation): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw invalidResponse(
      operation,
      "Teti Network returned an unsupported response content type.",
      response
    );
  }
  try {
    return await response.json();
  } catch {
    throw invalidResponse(operation, "Teti Network returned malformed JSON.", response);
  }
}

function validateContractHeaders(
  response: Response,
  body: unknown,
  operation: TetiNetworkOperation
): void {
  const protocol = parsePositiveIntegerHeader(response, "Teti-Protocol-Version", operation);
  const revision = parsePositiveIntegerHeader(response, "Teti-Contract-Revision", operation);
  const requestId = response.headers.get("X-Request-ID");
  if (!requestId || !UUID_PATTERN.test(requestId)) {
    throw invalidResponse(operation, "Teti Network response is missing a valid request ID.", response);
  }
  if (isRecord(body)) {
    if (typeof body.protocolVersion === "number" && body.protocolVersion !== protocol) {
      throw invalidResponse(
        operation,
        "Teti Network protocol header does not match the response body.",
        response
      );
    }
    if (typeof body.contractRevision === "number" && body.contractRevision !== revision) {
      throw invalidResponse(
        operation,
        "Teti Network contract header does not match the response body.",
        response
      );
    }
    if (typeof body.requestId === "string" && body.requestId !== requestId) {
      throw invalidResponse(operation, "Teti Network request IDs do not match.", response);
    }
  }
}

function parsePositiveIntegerHeader(
  response: Response,
  name: string,
  operation: TetiNetworkOperation
): number {
  const value = response.headers.get(name);
  const parsed = value === null ? NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalidResponse(
      operation,
      `Teti Network response is missing a valid ${name} header.`,
      response
    );
  }
  return parsed;
}

function parseBootstrap(value: unknown): TetiNetworkBootstrap {
  const operation = "bootstrap" as const;
  if (!isRecord(value)) throw invalidResponse(operation, "Teti Network bootstrap must be an object.");
  const protocolVersion = positiveInteger(value.protocolVersion, operation);
  const contractRevision = positiveInteger(value.contractRevision, operation);
  if (!isRecord(value.service) || value.service.name !== "teti-network") {
    throw invalidResponse(operation, "Teti Network bootstrap service identity is invalid.");
  }
  const serviceVersion = requireNonEmptyString(
    value.service.version,
    operation,
    "Teti Network bootstrap service version is invalid."
  );
  const serverTime = requireTimestamp(
    value.serverTime,
    operation,
    "Teti Network bootstrap server time is invalid."
  );
  if (!isRecord(value.protocolSupport)) {
    throw invalidResponse(operation, "Teti Network protocol support metadata is invalid.");
  }
  const minimumSupportedVersion = positiveInteger(
    value.protocolSupport.minimumSupportedVersion,
    operation
  );
  if (!Array.isArray(value.protocolSupport.supportedVersions)
    || value.protocolSupport.supportedVersions.length === 0) {
    throw invalidResponse(operation, "Teti Network supported protocol versions are invalid.");
  }
  const supportedVersions = value.protocolSupport.supportedVersions.map(
    (version) => positiveInteger(version, operation)
  );
  if (new Set(supportedVersions).size !== supportedVersions.length
    || !supportedVersions.includes(protocolVersion)
    || minimumSupportedVersion !== Math.min(...supportedVersions)) {
    throw invalidResponse(operation, "Teti Network protocol support metadata is inconsistent.");
  }
  const releasePolicy = parseReleasePolicy(value.releasePolicy);
  if (!isRecord(value.capabilities)) {
    throw invalidResponse(operation, "Teti Network bootstrap capabilities are invalid.");
  }
  const capabilities = {} as TetiNetworkCapabilities;
  for (const capability of TETI_NETWORK_CAPABILITIES) {
    const enabled = value.capabilities[capability];
    if (typeof enabled !== "boolean") {
      throw invalidResponse(operation, `Teti Network capability ${capability} is invalid.`);
    }
    capabilities[capability] = enabled;
  }
  const presencePolicy = parsePresencePolicy(value.presencePolicy, operation);

  return {
    protocolVersion,
    contractRevision,
    service: { name: "teti-network", version: serviceVersion },
    serverTime,
    protocolSupport: { minimumSupportedVersion, supportedVersions },
    releasePolicy,
    capabilities,
    presencePolicy
  };
}

function parsePresencePolicy(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkPresencePolicy {
  if (!isRecord(value)) {
    throw invalidResponse(operation, "Teti Network Presence policy is invalid.");
  }
  const expected = {
    collaborating: [5, 20],
    viewing_connect: [5, 20],
    online: [15, 45],
    background: [30, 90]
  } as const;
  const policy = {} as TetiNetworkPresencePolicy;
  for (const [mode, [reportEverySeconds, ttlSeconds]] of Object.entries(expected)) {
    const entry = value[mode];
    if (!isRecord(entry)
      || entry.reportEverySeconds !== reportEverySeconds
      || entry.ttlSeconds !== ttlSeconds) {
      throw invalidResponse(operation, `Teti Network Presence policy ${mode} is invalid.`);
    }
    policy[mode as TetiNetworkPresenceMode] = { reportEverySeconds, ttlSeconds };
  }
  return policy;
}

function parseReleasePolicy(value: unknown): TetiNetworkReleasePolicy {
  const operation = "bootstrap" as const;
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.channel !== "beta"
    || typeof value.minimumSupportedVersion !== "string"
    || !TETI_VERSION_PATTERN.test(value.minimumSupportedVersion)) {
    throw invalidResponse(operation, "Teti Network release policy is invalid.");
  }
  return {
    schemaVersion: 1,
    policyVersion: positiveInteger(value.policyVersion, operation),
    channel: "beta",
    minimumSupportedVersion: value.minimumSupportedVersion,
    effectiveAt: requireTimestamp(
      value.effectiveAt,
      operation,
      "Teti Network release policy effective time is invalid."
    )
  };
}

function parsePublicNode(value: unknown, operation: TetiNetworkOperation): TetiNetworkPublicNode {
  if (!isRecord(value)
    || !isRecord(value.delivery)
    || value.delivery.transport !== "chatmail"
    || typeof value.isDiscoverable !== "boolean") {
    throw invalidResponse(operation, "Teti Network public node is invalid.");
  }
  const id = requirePublicTetiId(value.id, operation, "response");
  return {
    id,
    identityPublicKey: requireNetworkPublicKey(value.identityPublicKey, operation),
    delivery: {
      transport: "chatmail",
      address: requireDeliveryAddress(value.delivery.address, operation),
      publicKey: nullableNonEmptyString(
        value.delivery.publicKey,
        operation,
        "Teti Network Chatmail public key is invalid."
      )
    },
    profile: parsePublicProfile(value.profile, operation),
    isDiscoverable: value.isDiscoverable,
    createdAt: requireTimestamp(value.createdAt, operation, "Teti Network node creation time is invalid."),
    updatedAt: requireTimestamp(value.updatedAt, operation, "Teti Network node update time is invalid.")
  };
}

function parsePublicNodeSummary(value: unknown): TetiNetworkPublicNodeSummary {
  const operation = "public_directory" as const;
  if (!isRecord(value) || !isRecord(value.delivery) || value.isDiscoverable !== true) {
    throw invalidResponse(operation, "Teti Network public directory item is invalid.");
  }
  const id = requirePublicTetiId(value.id, operation, "response");
  return {
    id,
    delivery: { address: requireDeliveryAddress(value.delivery.address, operation) },
    profile: parsePublicProfile(value.profile, operation),
    isDiscoverable: true,
    updatedAt: requireTimestamp(
      value.updatedAt,
      operation,
      "Teti Network directory update time is invalid."
    )
  };
}

function parsePublicProfile(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkPublicProfile {
  if (!isRecord(value)) throw invalidResponse(operation, "Teti Network public profile is invalid.");
  return {
    revision: nonNegativeInteger(value.revision, operation),
    displayName: nullableString(value.displayName, operation, "Teti Network display name is invalid."),
    avatarUrl: nullableUri(value.avatarUrl, operation),
    summary: nullableString(value.summary, operation, "Teti Network profile summary is invalid."),
    capabilitySummary: value.capabilitySummary === null
      ? null
      : parseCapabilitySummary(value.capabilitySummary, operation),
    updatedAt: nullableTimestamp(value.updatedAt, operation)
  };
}

function parseCapabilitySummary(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkPublicCapabilitySummary {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || (value.platform !== null && typeof value.platform !== "string")
    || !isStringArray(value.category)
    || !isStringArray(value.capabilityIds)
    || !isStringArray(value.aiEnvironment)) {
    throw invalidResponse(operation, "Teti Network capability summary is invalid.");
  }
  if ((value.platform !== null && !PUBLIC_PLATFORMS.has(value.platform))
    || value.aiEnvironment.length !== 0
    || !isCanonicalSlugArray(value.category, 8)
    || !isCanonicalSlugArray(value.capabilityIds, 32)) {
    throw invalidResponse(operation, "Teti Network capability summary is not canonical.");
  }
  return {
    schemaVersion: 1,
    platform: value.platform as TetiNetworkPublicCapabilitySummary["platform"],
    category: [...value.category],
    capabilityIds: [...value.capabilityIds],
    aiEnvironment: [...value.aiEnvironment]
  };
}

function parseProfileResult(
  response: Response,
  value: unknown,
  operation: "profile_self" | "profile_replace"
): TetiNetworkProfileResult {
  const document = parseProfileDocument(value, operation);
  const etag = response.headers.get("etag");
  if (etag !== profileEtag(document.revision)) {
    throw invalidResponse(operation, "Teti Network Profile ETag does not match its revision.", response);
  }
  if (response.headers.get("cache-control")?.trim().toLowerCase() !== "no-store") {
    throw invalidResponse(operation, "Teti Network Profile response is not marked no-store.", response);
  }
  return { document, etag: etag as TetiNetworkProfileEtag };
}

function parseProfileDocument(
  value: unknown,
  operation: "profile_self" | "profile_replace"
): TetiNetworkPublicProfileDocument {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.isDiscoverable !== "boolean"
    || !isRecord(value.profile)) {
    throw invalidResponse(operation, "Teti Network PublicProfile document is invalid.");
  }
  return {
    schemaVersion: 1,
    tetiId: requirePublicTetiId(value.tetiId, operation, "response"),
    revision: nonNegativeInteger(value.revision, operation),
    profile: parseProfileFields(value.profile, operation, "response"),
    isDiscoverable: value.isDiscoverable,
    updatedAt: nullableTimestamp(value.updatedAt, operation)
  };
}

function parseRelationshipResult(
  response: Response,
  value: unknown,
  operation:
    | "relationship_get"
    | "relationship_get_by_peer"
    | "relationship_request"
    | "relationship_accept"
    | "relationship_reject"
    | "relationship_block"
    | "relationship_revoke"
): TetiNetworkRelationshipResult {
  const document = parseRelationshipDocument(value, operation);
  const etag = response.headers.get("etag");
  if (etag !== relationshipEtag(document.revision)) {
    throw invalidResponse(operation, "Teti Network Relationship ETag does not match its revision.", response);
  }
  if (response.headers.get("cache-control")?.trim().toLowerCase() !== "no-store") {
    throw invalidResponse(operation, "Teti Network Relationship response is not marked no-store.", response);
  }
  return { document, etag: etag as TetiNetworkRelationshipEtag };
}

function parseRelationshipList(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkRelationshipListPage {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.page)) {
    throw invalidResponse(operation, "Teti Network Relationship list is invalid.");
  }
  const limit = boundedInteger(value.page.limit, 1, 100, operation);
  const returnedCount = boundedInteger(value.page.returnedCount, 0, 100, operation);
  if (returnedCount !== value.items.length || returnedCount > limit) {
    throw invalidResponse(operation, "Teti Network Relationship page counts are inconsistent.");
  }
  const nextCursor = value.page.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 512)) {
    throw invalidResponse(operation, "Teti Network Relationship cursor is invalid.");
  }
  const items = value.items.map((item) => parseRelationshipDocument(item, operation));
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!;
    const current = items[index]!;
    if (previous.updatedAt < current.updatedAt
      || (previous.updatedAt === current.updatedAt && previous.id.localeCompare(current.id) >= 0)) {
      throw invalidResponse(operation, "Teti Network Relationship list order is invalid.");
    }
  }
  return { items, page: { limit, returnedCount, nextCursor } };
}

function parseRelationshipDocument(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkRelationshipDocument {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !RELATIONSHIP_STATES.has(value.state as TetiNetworkRelationshipState)
    || (value.direction !== "outgoing" && value.direction !== "incoming")
    || (value.blockedBy !== null && value.blockedBy !== "self" && value.blockedBy !== "peer")) {
    throw invalidResponse(operation, "Teti Network Relationship document is invalid.");
  }
  const peerTetiId = requirePublicTetiId(value.peerTetiId, operation, "response");
  const requesterTetiId = requirePublicTetiId(value.requesterTetiId, operation, "response");
  const addresseeTetiId = requirePublicTetiId(value.addresseeTetiId, operation, "response");
  if (peerTetiId === requesterTetiId && peerTetiId === addresseeTetiId) {
    throw invalidResponse(operation, "Teti Network Relationship members are inconsistent.");
  }
  if (requesterTetiId === addresseeTetiId) {
    throw invalidResponse(operation, "Teti Network Relationship members must differ.");
  }
  if ((value.state === "blocked") !== (value.blockedBy !== null)) {
    throw invalidResponse(operation, "Teti Network Relationship block projection is inconsistent.");
  }
  const createdAt = requireTimestamp(value.createdAt, operation, "Relationship creation time is invalid.");
  const updatedAt = requireTimestamp(value.updatedAt, operation, "Relationship update time is invalid.");
  const stateChangedAt = requireTimestamp(
    value.stateChangedAt,
    operation,
    "Relationship state-change time is invalid."
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt)
    || Date.parse(stateChangedAt) < Date.parse(createdAt)
    || Date.parse(stateChangedAt) > Date.parse(updatedAt)) {
    throw invalidResponse(operation, "Teti Network Relationship timestamps are inconsistent.");
  }
  return {
    schemaVersion: 1,
    id: requireRelationshipId(value.id, operation, "response"),
    revision: boundedInteger(value.revision, 1, Number.MAX_SAFE_INTEGER, operation),
    state: value.state as TetiNetworkRelationshipState,
    peerTetiId,
    requesterTetiId,
    addresseeTetiId,
    direction: value.direction,
    blockedBy: value.blockedBy,
    createdAt,
    updatedAt,
    stateChangedAt
  };
}

function requireRelationshipRequest(
  value: TetiNetworkRequestRelationshipRequest
): TetiNetworkRequestRelationshipRequest {
  const operation = "relationship_request" as const;
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["schemaVersion", "peerTetiId", "expectedRevision"])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision < 0) {
    throw invalidRequest(operation, "Teti Network Relationship request is invalid.");
  }
  return {
    schemaVersion: 1,
    peerTetiId: requirePublicTetiId(value.peerTetiId, operation, "request"),
    expectedRevision: value.expectedRevision
  };
}

function requireRelationshipMutation(
  value: TetiNetworkMutateRelationshipRequest,
  operation: TetiNetworkOperation
): TetiNetworkMutateRelationshipRequest {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["schemaVersion", "expectedRevision"])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision < 0) {
    throw invalidRequest(operation, "Teti Network Relationship command is invalid.");
  }
  return { schemaVersion: 1, expectedRevision: value.expectedRevision };
}

function requireProfileReplacementRequest(
  value: TetiNetworkReplacePublicProfileRequest
): TetiNetworkReplacePublicProfileRequest {
  const operation = "profile_replace" as const;
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision < 0
    || typeof value.isDiscoverable !== "boolean"
    || !hasOnlyKeys(value, ["schemaVersion", "expectedRevision", "profile", "isDiscoverable"])) {
    throw invalidRequest(operation, "Teti Network PublicProfile replacement is invalid.");
  }
  return {
    schemaVersion: 1,
    expectedRevision: value.expectedRevision,
    profile: parseProfileFields(value.profile, operation, "request"),
    isDiscoverable: value.isDiscoverable
  };
}

function parseProfileFields(
  value: unknown,
  operation: "profile_self" | "profile_replace",
  source: "request" | "response"
): TetiNetworkPublicProfileDocument["profile"] {
  const fail = (message: string): never => {
    throw source === "request" ? invalidRequest(operation, message) : invalidResponse(operation, message);
  };
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["displayName", "avatarUrl", "summary", "capabilitySummary"])) {
    return fail("Teti Network PublicProfile fields are invalid.");
  }
  const displayName = requireNullableProfileString(
    value.displayName,
    80,
    fail,
    "Teti Network display name is invalid."
  );
  const summary = requireNullableProfileString(
    value.summary,
    512,
    fail,
    "Teti Network profile summary is invalid."
  );
  let avatarUrl: string | null;
  if (value.avatarUrl === null) avatarUrl = null;
  else if (typeof value.avatarUrl === "string" && value.avatarUrl.length <= 2048) {
    try {
      new URL(value.avatarUrl);
      avatarUrl = value.avatarUrl;
    } catch {
      return fail("Teti Network avatar URL is invalid.");
    }
  } else return fail("Teti Network avatar URL is invalid.");
  return {
    displayName,
    avatarUrl,
    summary,
    capabilitySummary: value.capabilitySummary === null
      ? null
      : parseCapabilitySummaryWrite(value.capabilitySummary, operation, source)
  };
}

function parseCapabilitySummaryWrite(
  value: unknown,
  operation: "profile_self" | "profile_replace",
  source: "request" | "response"
): TetiNetworkPublicCapabilitySummaryWrite {
  const fail = (message: string): never => {
    throw source === "request" ? invalidRequest(operation, message) : invalidResponse(operation, message);
  };
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !hasOnlyKeys(value, ["schemaVersion", "platform", "category", "capabilityIds"])
    || (value.platform !== null && !PUBLIC_PLATFORMS.has(value.platform as string))
    || !isCanonicalSlugArray(value.category, 8)
    || !isCanonicalSlugArray(value.capabilityIds, 32)) {
    return fail("Teti Network PublicCapabilitySummary is invalid.");
  }
  return {
    schemaVersion: 1,
    platform: value.platform as TetiNetworkPublicCapabilitySummaryWrite["platform"],
    category: [...value.category],
    capabilityIds: [...value.capabilityIds]
  };
}

function parsePublicDirectory(value: unknown): TetiNetworkPublicDirectoryPage {
  const operation = "public_directory" as const;
  if (!isRecord(value)
    || !Array.isArray(value.items)
    || !isRecord(value.page)
    || !PUBLIC_DIRECTORY_SORTS.has(value.sort as TetiNetworkPublicDirectorySort)) {
    throw invalidResponse(operation, "Teti Network public directory page is invalid.");
  }
  const items = value.items.map(parsePublicNodeSummary);
  const limit = boundedInteger(value.page.limit, 1, 50, operation);
  const returnedCount = boundedInteger(value.page.returnedCount, 0, 50, operation);
  if (items.length !== returnedCount || returnedCount > limit) {
    throw invalidResponse(operation, "Teti Network public directory counts are inconsistent.");
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw invalidResponse(operation, "Teti Network public directory contains duplicate nodes.");
  }
  const nextCursor = value.page.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 2048)) {
    throw invalidResponse(operation, "Teti Network public directory cursor is invalid.");
  }
  return {
    items,
    page: { limit, returnedCount, nextCursor },
    sort: value.sort as TetiNetworkPublicDirectorySort
  };
}

function parsePublicStats(value: unknown): TetiNetworkPublicStats {
  const operation = "public_stats" as const;
  if (!isRecord(value)) throw invalidResponse(operation, "Teti Network public stats are invalid.");
  const activeIdentityCount = nonNegativeInteger(value.activeIdentityCount, operation);
  const discoverableNodeCount = nonNegativeInteger(value.discoverableNodeCount, operation);
  if (discoverableNodeCount > activeIdentityCount) {
    throw invalidResponse(operation, "Teti Network public stats are inconsistent.");
  }
  return {
    activeIdentityCount,
    discoverableNodeCount,
    generatedAt: requireTimestamp(
      value.generatedAt,
      operation,
      "Teti Network public stats timestamp is invalid."
    )
  };
}

function parseIdentitySession(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkIdentitySession {
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.delivery)) {
    throw invalidResponse(operation, "Teti Network identity session is invalid.");
  }
  const identity = value.identity;
  const tetiId = requirePublicTetiId(identity.tetiId, operation, "response");
  return {
    identity: {
      tetiId,
      identityPublicKey: requireNetworkPublicKey(identity.identityPublicKey, operation),
      status: requireStatus(identity.status, operation),
      createdAt: requireTimestamp(
        identity.createdAt,
        operation,
        "Teti Network identity creation time is invalid."
      ),
      updatedAt: requireTimestamp(
        identity.updatedAt,
        operation,
        "Teti Network identity update time is invalid."
      )
    },
    clientInstance: parseClientInstance(value.clientInstance, operation),
    delivery: {
      address: requireDeliveryAddress(value.delivery.address, operation),
      publicKey: nullableNonEmptyString(
        value.delivery.publicKey,
        operation,
        "Teti Network Chatmail public key is invalid."
      )
    }
  };
}

function parseClientInstanceMutation(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkClientInstanceDocument {
  if (!isRecord(value)) {
    throw invalidResponse(operation, "Teti Network client mutation response is invalid.");
  }
  return parseClientInstance(value.clientInstance, operation);
}

function requirePresenceReportRequest(
  value: TetiNetworkPresenceReportRequest
): TetiNetworkPresenceReportRequest {
  const operation = "presence_report" as const;
  if (value.schemaVersion !== 1
    || !/^ps_[A-Za-z0-9_-]{22}$/.test(value.sessionId)
    || Buffer.from(value.sessionId.slice(3), "base64url").toString("base64url") !== value.sessionId.slice(3)
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || !isPresenceMode(value.mode)
    || (value.activityMarker !== null && value.activityMarker !== "collaboration_active")) {
    throw invalidRequest(operation, "Teti Network Presence report is invalid.");
  }
  return {
    schemaVersion: 1,
    sessionId: value.sessionId,
    sequence: value.sequence,
    mode: value.mode,
    activityMarker: value.activityMarker
  };
}

function parsePresenceReport(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkPresenceReportResponse {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isPresenceMode(value.mode)
    || (value.activityMarker !== null && value.activityMarker !== "collaboration_active")
    || typeof value.sessionId !== "string"
    || !/^ps_[A-Za-z0-9_-]{22}$/.test(value.sessionId)) {
    throw invalidResponse(operation, "Teti Network Presence report response is invalid.");
  }
  return {
    schemaVersion: 1,
    tetiId: requirePublicTetiId(value.tetiId, operation, "response"),
    sessionId: value.sessionId,
    sequence: positiveInteger(value.sequence, operation),
    mode: value.mode,
    activityMarker: value.activityMarker,
    reportedAt: requireTimestamp(value.reportedAt, operation, "Presence report time is invalid."),
    expiresAt: requireTimestamp(value.expiresAt, operation, "Presence expiry is invalid."),
    expiresInSeconds: boundedInteger(value.expiresInSeconds, 1, 90, operation)
  };
}

function parsePresenceRead(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkPresenceReadResponse {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw invalidResponse(operation, "Teti Network Presence read response is invalid.");
  }
  const tetiId = requirePublicTetiId(value.tetiId, operation, "response");
  const observedAt = requireTimestamp(value.observedAt, operation, "Presence observation time is invalid.");
  if (value.state === "offline") {
    if (value.mode !== null || value.activityMarker !== null || value.reportedAt !== null
      || value.expiresAt !== null || value.expiresInSeconds !== 0) {
      throw invalidResponse(operation, "Teti Network offline Presence is invalid.");
    }
    return {
      schemaVersion: 1,
      tetiId,
      state: "offline",
      mode: null,
      activityMarker: null,
      reportedAt: null,
      observedAt,
      expiresAt: null,
      expiresInSeconds: 0
    };
  }
  if (value.state !== "online"
    || !isPresenceMode(value.mode)
    || (value.activityMarker !== null && value.activityMarker !== "collaboration_active")) {
    throw invalidResponse(operation, "Teti Network online Presence is invalid.");
  }
  return {
    schemaVersion: 1,
    tetiId,
    state: "online",
    mode: value.mode,
    activityMarker: value.activityMarker,
    reportedAt: requireTimestamp(value.reportedAt, operation, "Presence report time is invalid."),
    observedAt,
    expiresAt: requireTimestamp(value.expiresAt, operation, "Presence expiry is invalid."),
    expiresInSeconds: boundedInteger(value.expiresInSeconds, 1, 90, operation)
  };
}

function isPresenceMode(value: unknown): value is TetiNetworkPresenceMode {
  return value === "collaborating"
    || value === "viewing_connect"
    || value === "online"
    || value === "background";
}

function parseClientInstance(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkClientInstanceDocument {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || !CLIENT_INSTANCE_ID_PATTERN.test(value.id)
    || typeof value.platform !== "string"
    || !value.platform
    || typeof value.appVersion !== "string"
    || !value.appVersion) {
    throw invalidResponse(operation, "Teti Network client instance is invalid.");
  }
  return {
    id: value.id,
    publicKey: requireNetworkPublicKey(value.publicKey, operation),
    platform: value.platform,
    appVersion: value.appVersion,
    status: requireStatus(value.status, operation),
    createdAt: requireTimestamp(
      value.createdAt,
      operation,
      "Teti Network client creation time is invalid."
    ),
    lastSeenAt: nullableTimestamp(value.lastSeenAt, operation),
    revokedAt: nullableTimestamp(value.revokedAt, operation)
  };
}

function publicDirectoryQuery(query: TetiNetworkPublicDirectoryQuery): string {
  const operation = "public_directory" as const;
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50) {
      throw invalidRequest(operation, "Teti Network directory limit is invalid.");
    }
    params.set("limit", String(query.limit));
  }
  if (query.sort !== undefined) {
    if (!PUBLIC_DIRECTORY_SORTS.has(query.sort)) {
      throw invalidRequest(operation, "Teti Network directory sort is invalid.");
    }
    params.set("sort", query.sort);
  }
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || !query.cursor || query.cursor.length > 2048) {
      throw invalidRequest(operation, "Teti Network directory cursor is invalid.");
    }
    params.set("cursor", query.cursor);
  }
  return params.toString();
}

function relationshipListQuery(query: TetiNetworkRelationshipListQuery): string {
  const operation = "relationship_list" as const;
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw invalidRequest(operation, "Teti Network Relationship list limit is invalid.");
    }
    params.set("limit", String(query.limit));
  }
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || !query.cursor || query.cursor.length > 512) {
      throw invalidRequest(operation, "Teti Network Relationship cursor is invalid.");
    }
    params.set("cursor", query.cursor);
  }
  return params.toString();
}

function errorFromResponse(
  response: Response,
  body: unknown,
  operation: TetiNetworkOperation
): TetiNetworkClientError {
  if (!isNetworkErrorEnvelope(body)) {
    return invalidResponse(operation, "Teti Network returned an invalid error response.", response);
  }
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  return new TetiNetworkClientError({
    code: mapServerError(body.error.code, response.status),
    operation,
    message: safeServerMessage(body.error.message),
    retryable: body.error.retryable,
    requestId: body.requestId,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    status: response.status
  });
}

function mapServerError(code: string, status: number): TetiNetworkErrorCode {
  if (code === "IDENTITY_NOT_FOUND") return "IDENTITY_NOT_FOUND";
  if (code === "IDENTITY_ALREADY_EXISTS") return "IDENTITY_ALREADY_EXISTS";
  if (code === "NETWORK_UNAUTHORIZED") return "NETWORK_UNAUTHORIZED";
  if (code === "NETWORK_CLIENT_REVOKED") return "NETWORK_CLIENT_REVOKED";
  if (code === "REQUEST_REPLAYED") return "REQUEST_REPLAYED";
  if (code === "IDEMPOTENCY_CONFLICT") return "IDEMPOTENCY_CONFLICT";
  if (code === "PRESENCE_SEQUENCE_STALE") return "PRESENCE_SEQUENCE_STALE";
  if (code === "RELATIONSHIP_NOT_FOUND") return "RELATIONSHIP_NOT_FOUND";
  if (code === "RELATIONSHIP_TRANSITION_INVALID") return "RELATIONSHIP_TRANSITION_INVALID";
  if (code === "RELATIONSHIP_BLOCKED") return "RELATIONSHIP_BLOCKED";
  if (code === "RELATIONSHIP_REVISION_CONFLICT") return "RELATIONSHIP_REVISION_CONFLICT";
  if (code === "PROFILE_REVISION_CONFLICT") return "PROFILE_REVISION_CONFLICT";
  if (status === 412) return "NETWORK_CONFLICT";
  if (code === "NETWORK_CONFLICT") return "NETWORK_CONFLICT";
  if (code === "PROTOCOL_UNSUPPORTED" || status === 426) return "PROTOCOL_UNSUPPORTED";
  if (code === "RATE_LIMITED" || status === 429) return "RATE_LIMITED";
  if (code === "DEPENDENCY_UNAVAILABLE" || code === "INTERNAL_ERROR" || status >= 500) {
    return "SERVER_UNAVAILABLE";
  }
  if (code === "REQUEST_INVALID" || code === "REQUEST_BODY_TOO_LARGE" || code === "CONTENT_TYPE_UNSUPPORTED") {
    return "NETWORK_REQUEST_INVALID";
  }
  if (status === 401) return "NETWORK_UNAUTHORIZED";
  if (status === 403) return "NETWORK_CLIENT_REVOKED";
  if (status === 409) return "NETWORK_CONFLICT";
  return "NETWORK_REQUEST_REJECTED";
}

function profileEtag(revision: number): TetiNetworkProfileEtag {
  return `"profile-r${revision}"`;
}

function relationshipEtag(revision: number): TetiNetworkRelationshipEtag {
  return `"relationship-r${revision}"`;
}

function relationshipCommandOperation(
  command: TetiNetworkRelationshipCommand
):
  | "relationship_accept"
  | "relationship_reject"
  | "relationship_block"
  | "relationship_revoke" {
  switch (command) {
    case "accept": return "relationship_accept";
    case "reject": return "relationship_reject";
    case "block": return "relationship_block";
    case "revoke": return "relationship_revoke";
    default: throw invalidRequest("relationship_get", "Teti Network Relationship command is invalid.");
  }
}

function assertPersistedBody(
  operation: TetiNetworkOperation,
  input: unknown,
  rawBody: string
): void {
  try {
    if (JSON.stringify(JSON.parse(rawBody)) !== JSON.stringify(input)) throw new Error("body mismatch");
  } catch {
    throw invalidRequest(operation, "Teti Network persisted write body is invalid.");
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isCanonicalSlugArray(value: unknown, maxItems: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  if (!value.every((item) => typeof item === "string"
    && item.length <= 64
    && PUBLIC_SLUG_PATTERN.test(item))) return false;
  const sorted = [...value].sort((left, right) => left.localeCompare(right));
  return new Set(value).size === value.length
    && sorted.every((item, index) => item === value[index]);
}

function requireNullableProfileString(
  value: unknown,
  maxLength: number,
  fail: (message: string) => never,
  message: string
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) return fail(message);
  return value;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function safeServerMessage(value: string): string {
  const singleLine = value.replace(/[\r\n]/g, " ").trim();
  return singleLine ? singleLine.slice(0, 240) : "Teti Network request failed.";
}

function isNetworkErrorEnvelope(value: unknown): value is NetworkErrorEnvelope {
  return isRecord(value)
    && isRecord(value.error)
    && typeof value.error.code === "string"
    && typeof value.error.message === "string"
    && typeof value.error.retryable === "boolean"
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId);
}

function invalidRequest(operation: TetiNetworkOperation, message: string): TetiNetworkClientError {
  return new TetiNetworkClientError({
    code: "NETWORK_REQUEST_INVALID",
    operation,
    message,
    retryable: false
  });
}

function invalidResponse(
  operation: TetiNetworkOperation,
  message: string,
  response?: Response
): TetiNetworkClientError {
  return new TetiNetworkClientError({
    code: "NETWORK_INVALID_RESPONSE",
    operation,
    message,
    retryable: true,
    ...(response ? { status: response.status } : {})
  });
}

function requirePublicTetiId(
  value: unknown,
  operation: TetiNetworkOperation,
  source: "request" | "response"
): string {
  if (typeof value !== "string" || !TETI_PUBLIC_ID_PATTERN.test(value)) {
    throw source === "request"
      ? invalidRequest(operation, "Teti Network public ID is invalid.")
      : invalidResponse(operation, "Teti Network public ID is invalid.");
  }
  return value;
}

function requireRelationshipId(
  value: unknown,
  operation: TetiNetworkOperation,
  source: "request" | "response"
): string {
  if (typeof value !== "string"
    || !RELATIONSHIP_ID_PATTERN.test(value)
    || Buffer.from(value.slice(4), "base64url").toString("base64url") !== value.slice(4)) {
    throw source === "request"
      ? invalidRequest(operation, "Teti Network Relationship ID is invalid.")
      : invalidResponse(operation, "Teti Network Relationship ID is invalid.");
  }
  return value;
}

function requireDeliveryAddress(value: unknown, operation: TetiNetworkOperation): string {
  if (typeof value !== "string") {
    throw invalidResponse(operation, "Teti Network delivery address is invalid.");
  }
  const separator = value.lastIndexOf("@");
  const mailbox = separator > 0 ? value.slice(0, separator) : "";
  const domain = separator > 0 ? value.slice(separator + 1) : "";
  if (value.length > 320
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(mailbox)
    || !DELIVERY_DOMAIN_PATTERN.test(domain)) {
    throw invalidResponse(operation, "Teti Network delivery address is invalid.");
  }
  return value;
}

function requireNetworkPublicKey(
  value: unknown,
  operation: TetiNetworkOperation
): TetiNetworkIdentitySession["identity"]["identityPublicKey"] {
  if (typeof value !== "string") {
    throw invalidResponse(operation, "Teti Network Ed25519 public key is invalid.");
  }
  try {
    return requireEd25519PublicKey(value);
  } catch {
    throw invalidResponse(operation, "Teti Network Ed25519 public key is invalid.");
  }
}

function requireStatus(
  value: unknown,
  operation: TetiNetworkOperation
): "active" | "revoked" {
  if (value !== "active" && value !== "revoked") {
    throw invalidResponse(operation, "Teti Network resource status is invalid.");
  }
  return value;
}

function nullableTimestamp(
  value: unknown,
  operation: TetiNetworkOperation
): string | null {
  return value === null
    ? null
    : requireTimestamp(value, operation, "Teti Network timestamp is invalid.");
}

function requireNonEmptyString(
  value: unknown,
  operation: TetiNetworkOperation,
  message: string
): string {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse(operation, message);
  return value;
}

function nullableNonEmptyString(
  value: unknown,
  operation: TetiNetworkOperation,
  message: string
): string | null {
  if (value === null) return null;
  return requireNonEmptyString(value, operation, message);
}

function nullableString(
  value: unknown,
  operation: TetiNetworkOperation,
  message: string
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalidResponse(operation, message);
  return value;
}

function nullableUri(value: unknown, operation: TetiNetworkOperation): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw invalidResponse(operation, "Teti Network avatar URL is invalid.");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported URI");
    return value;
  } catch {
    throw invalidResponse(operation, "Teti Network avatar URL is invalid.");
  }
}

function requireTimestamp(
  value: unknown,
  operation: TetiNetworkOperation,
  message: string
): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw invalidResponse(operation, message);
  }
  return new Date(value).toISOString();
}

function positiveInteger(value: unknown, operation: TetiNetworkOperation): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidResponse(operation, "Teti Network version metadata is invalid.");
  }
  return value;
}

function nonNegativeInteger(value: unknown, operation: TetiNetworkOperation): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, operation);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  operation: TetiNetworkOperation
): number {
  if (typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum) {
    throw invalidResponse(operation, "Teti Network numeric response metadata is invalid.");
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
