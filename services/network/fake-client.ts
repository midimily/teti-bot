import { TetiNetworkClientError } from "./errors.ts";
import type {
  TetiNetworkAdoptIdentityRequest,
  TetiNetworkAuthenticatedSigner,
  TetiNetworkBootstrap,
  TetiNetworkClient,
  TetiNetworkClientInstanceDocument,
  TetiNetworkEnrollClientInstanceRequest,
  TetiNetworkIdentitySession,
  TetiNetworkProfileResult,
  TetiNetworkProfileWriteOptions,
  TetiNetworkPublicDirectoryPage,
  TetiNetworkPublicDirectoryQuery,
  TetiNetworkPublicNode,
  TetiNetworkPublicStats,
  TetiNetworkPresenceReadResponse,
  TetiNetworkPresenceReportRequest,
  TetiNetworkPresenceReportResponse,
  TetiNetworkRegisterIdentityRequest,
  TetiNetworkAdoptRelayBindingRequest,
  TetiNetworkMutateRelayBindingRequest,
  TetiNetworkPutRelayBindingRequest,
  TetiNetworkRelayBindingResult,
  TetiNetworkRelayBindingWriteOptions,
  TetiNetworkRelayCatalog,
  TetiNetworkRelationshipCommand,
  TetiNetworkRelationshipAuthorization,
  TetiNetworkRelationshipChangesPage,
  TetiNetworkRelationshipChangesQuery,
  TetiNetworkRelationshipListPage,
  TetiNetworkRelationshipListQuery,
  TetiNetworkRelationshipResult,
  TetiNetworkRelationshipSnapshotPage,
  TetiNetworkRelationshipSnapshotQuery,
  TetiNetworkRelationshipWriteOptions,
  TetiNetworkRequestRelationshipRequest,
  TetiNetworkMutateRelationshipRequest,
  TetiNetworkReplacePublicProfileRequest,
  TetiNetworkSigningKey,
  TetiNetworkWriteOptions
} from "./types.ts";

export class FakeTetiNetworkClient implements TetiNetworkClient {
  calls = 0;
  readonly publicNodeCalls: string[] = [];
  readonly publicDirectoryCalls: TetiNetworkPublicDirectoryQuery[] = [];
  publicStatsCalls = 0;
  relayListCalls = 0;
  readonly registerCalls: TetiNetworkRegisterIdentityRequest[] = [];
  readonly adoptCalls: TetiNetworkAdoptIdentityRequest[] = [];
  readonly selfCalls: TetiNetworkAuthenticatedSigner[] = [];
  readonly relayBindingSelfCalls: TetiNetworkAuthenticatedSigner[] = [];
  readonly relayBindingCreateCalls: Array<{
    input: TetiNetworkPutRelayBindingRequest;
    options: TetiNetworkRelayBindingWriteOptions;
  }> = [];
  readonly relayBindingAdoptCalls: Array<{
    input: TetiNetworkAdoptRelayBindingRequest;
    options: TetiNetworkRelayBindingWriteOptions;
  }> = [];
  readonly relayBindingMutationCalls: Array<{
    bindingId: string;
    command: "activate" | "revoke";
    input: TetiNetworkMutateRelayBindingRequest;
    options: TetiNetworkRelayBindingWriteOptions;
  }> = [];
  readonly enrollCalls: TetiNetworkEnrollClientInstanceRequest[] = [];
  readonly revokeCalls: string[] = [];
  readonly presenceReportCalls: TetiNetworkPresenceReportRequest[] = [];
  readonly presenceReadCalls: string[] = [];
  readonly profileSelfCalls: TetiNetworkAuthenticatedSigner[] = [];
  readonly profileReplaceCalls: Array<{
    input: TetiNetworkReplacePublicProfileRequest;
    options: TetiNetworkProfileWriteOptions;
  }> = [];
  readonly relationshipListCalls: TetiNetworkRelationshipListQuery[] = [];
  readonly relationshipGetCalls: string[] = [];
  readonly relationshipPeerCalls: string[] = [];
  readonly relationshipAuthorizationCalls: string[] = [];
  readonly relationshipSnapshotCalls: TetiNetworkRelationshipSnapshotQuery[] = [];
  readonly relationshipChangesCalls: TetiNetworkRelationshipChangesQuery[] = [];
  readonly relationshipRequestCalls: Array<{
    input: TetiNetworkRequestRelationshipRequest;
    options: TetiNetworkRelationshipWriteOptions;
  }> = [];
  readonly relationshipMutationCalls: Array<{
    relationshipId: string;
    command: TetiNetworkRelationshipCommand;
    input: TetiNetworkMutateRelationshipRequest;
    options: TetiNetworkRelationshipWriteOptions;
  }> = [];
  private bootstrapValue: TetiNetworkBootstrap;
  private errorValue: unknown = null;
  private readonly publicNodes = new Map<string, TetiNetworkPublicNode>();
  private publicDirectoryValue: TetiNetworkPublicDirectoryPage = {
    items: [],
    page: { limit: 20, returnedCount: 0, nextCursor: null },
    sort: "updated_desc"
  };
  private publicStatsValue: TetiNetworkPublicStats = {
    activeIdentityCount: 0,
    discoverableNodeCount: 0,
    generatedAt: new Date(0).toISOString()
  };
  private relayCatalogValue: TetiNetworkRelayCatalog = {
    schemaVersion: 1,
    relays: [],
    generatedAt: new Date(0).toISOString()
  };
  private relayBindingResultValue: TetiNetworkRelayBindingResult | null = null;
  private identitySessionValue: TetiNetworkIdentitySession | null = null;
  private clientMutationValue: TetiNetworkClientInstanceDocument | null = null;
  private presenceReportValue: TetiNetworkPresenceReportResponse | null = null;
  private readonly presenceReadValues = new Map<string, TetiNetworkPresenceReadResponse>();
  private profileResultValue: TetiNetworkProfileResult | null = null;
  private relationshipListValue: TetiNetworkRelationshipListPage = {
    items: [],
    page: { limit: 50, returnedCount: 0, nextCursor: null }
  };
  private readonly relationshipValues = new Map<string, TetiNetworkRelationshipResult>();
  private readonly relationshipPeerValues = new Map<string, TetiNetworkRelationshipResult>();
  private readonly relationshipAuthorizationValues = new Map<string, TetiNetworkRelationshipAuthorization>();
  private relationshipSnapshotValue: TetiNetworkRelationshipSnapshotPage = {
    schemaVersion: 1,
    items: [],
    baseCheckpoint: "rcp_empty",
    page: { limit: 100, returnedCount: 0, nextCursor: null }
  };
  private relationshipChangesValue: TetiNetworkRelationshipChangesPage = {
    schemaVersion: 1,
    items: [],
    checkpoint: "rcp_empty",
    page: { limit: 100, returnedCount: 0, hasMore: false }
  };

  constructor(bootstrap: TetiNetworkBootstrap) {
    this.bootstrapValue = structuredClone(bootstrap);
  }

  setBootstrap(bootstrap: TetiNetworkBootstrap): void {
    this.bootstrapValue = structuredClone(bootstrap);
    this.errorValue = null;
  }

  setError(error: unknown): void {
    this.errorValue = error;
  }

  setPublicNode(node: TetiNetworkPublicNode): void {
    this.publicNodes.set(node.id, structuredClone(node));
  }

  setPublicDirectory(page: TetiNetworkPublicDirectoryPage): void {
    this.publicDirectoryValue = structuredClone(page);
  }

  setPublicStats(stats: TetiNetworkPublicStats): void {
    this.publicStatsValue = structuredClone(stats);
  }

  setRelayCatalog(catalog: TetiNetworkRelayCatalog): void {
    this.relayCatalogValue = structuredClone(catalog);
  }

  setRelayBindingResult(result: TetiNetworkRelayBindingResult): void {
    this.relayBindingResultValue = structuredClone(result);
  }

  setIdentitySession(session: TetiNetworkIdentitySession): void {
    this.identitySessionValue = structuredClone(session);
  }

  setClientMutation(client: TetiNetworkClientInstanceDocument): void {
    this.clientMutationValue = structuredClone(client);
  }

  setPresenceReport(response: TetiNetworkPresenceReportResponse): void {
    this.presenceReportValue = structuredClone(response);
  }

  setPresenceRead(response: TetiNetworkPresenceReadResponse): void {
    this.presenceReadValues.set(response.tetiId, structuredClone(response));
  }

  setProfileResult(result: TetiNetworkProfileResult): void {
    this.profileResultValue = structuredClone(result);
  }

  setRelationshipList(page: TetiNetworkRelationshipListPage): void {
    this.relationshipListValue = structuredClone(page);
  }

  setRelationshipResult(result: TetiNetworkRelationshipResult): void {
    this.relationshipValues.set(result.document.id, structuredClone(result));
    this.relationshipPeerValues.set(result.document.peerTetiId, structuredClone(result));
  }

  setRelationshipAuthorization(value: TetiNetworkRelationshipAuthorization): void {
    this.relationshipAuthorizationValues.set(value.peerTetiId, structuredClone(value));
  }

  setRelationshipSnapshot(page: TetiNetworkRelationshipSnapshotPage): void {
    this.relationshipSnapshotValue = structuredClone(page);
  }

  setRelationshipChanges(page: TetiNetworkRelationshipChangesPage): void {
    this.relationshipChangesValue = structuredClone(page);
  }

  async getBootstrap(signal?: AbortSignal): Promise<TetiNetworkBootstrap> {
    this.calls += 1;
    if (signal?.aborted) throw signal.reason ?? new Error("Network bootstrap was cancelled.");
    if (this.errorValue !== null) throw this.errorValue;
    return structuredClone(this.bootstrapValue);
  }

  async getPublicNode(tetiId: string, signal?: AbortSignal): Promise<TetiNetworkPublicNode> {
    assertNotAborted(signal);
    this.publicNodeCalls.push(tetiId);
    const node = this.publicNodes.get(tetiId);
    if (!node) {
      throw new TetiNetworkClientError({
        code: "IDENTITY_NOT_FOUND",
        operation: "public_node",
        message: "The requested Teti identity could not be resolved.",
        retryable: false,
        status: 404
      });
    }
    return structuredClone(node);
  }

  async listPublicNodes(
    query: TetiNetworkPublicDirectoryQuery = {},
    signal?: AbortSignal
  ): Promise<TetiNetworkPublicDirectoryPage> {
    assertNotAborted(signal);
    this.publicDirectoryCalls.push(structuredClone(query));
    return structuredClone(this.publicDirectoryValue);
  }

  async getPublicStats(signal?: AbortSignal): Promise<TetiNetworkPublicStats> {
    assertNotAborted(signal);
    this.publicStatsCalls += 1;
    return structuredClone(this.publicStatsValue);
  }

  async listRelays(signal?: AbortSignal): Promise<TetiNetworkRelayCatalog> {
    assertNotAborted(signal);
    this.relayListCalls += 1;
    if (this.errorValue !== null) throw this.errorValue;
    return structuredClone(this.relayCatalogValue);
  }

  async registerIdentity(
    input: TetiNetworkRegisterIdentityRequest,
    _pendingClient: TetiNetworkSigningKey,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkIdentitySession> {
    assertNotAborted(options.signal);
    this.registerCalls.push(structuredClone(input));
    return this.requireIdentitySession();
  }

  async adoptIdentity(
    input: TetiNetworkAdoptIdentityRequest,
    _pendingClient: TetiNetworkSigningKey,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkIdentitySession> {
    assertNotAborted(options.signal);
    this.adoptCalls.push(structuredClone(input));
    return this.requireIdentitySession();
  }

  async getIdentitySelf(
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkIdentitySession> {
    assertNotAborted(signal);
    this.selfCalls.push(authentication);
    return this.requireIdentitySession();
  }

  async getRelayBindingsSelf(
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelayBindingResult> {
    assertNotAborted(signal);
    this.relayBindingSelfCalls.push(authentication);
    return this.requireRelayBindingResult();
  }

  async createRelayBinding(
    input: TetiNetworkPutRelayBindingRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelayBindingWriteOptions
  ): Promise<TetiNetworkRelayBindingResult> {
    assertNotAborted(options.signal);
    this.relayBindingCreateCalls.push({ input: structuredClone(input), options: { ...options } });
    return this.requireRelayBindingResult();
  }

  async adoptRelayBinding(
    input: TetiNetworkAdoptRelayBindingRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelayBindingWriteOptions
  ): Promise<TetiNetworkRelayBindingResult> {
    assertNotAborted(options.signal);
    this.relayBindingAdoptCalls.push({ input: structuredClone(input), options: { ...options } });
    return this.requireRelayBindingResult();
  }

  async mutateRelayBinding(
    bindingId: string,
    command: "activate" | "revoke",
    input: TetiNetworkMutateRelayBindingRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelayBindingWriteOptions
  ): Promise<TetiNetworkRelayBindingResult> {
    assertNotAborted(options.signal);
    this.relayBindingMutationCalls.push({
      bindingId,
      command,
      input: structuredClone(input),
      options: { ...options }
    });
    return this.requireRelayBindingResult();
  }

  async getProfileSelf(
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkProfileResult> {
    assertNotAborted(signal);
    this.profileSelfCalls.push(authentication);
    return this.requireProfileResult();
  }

  async replaceProfileSelf(
    input: TetiNetworkReplacePublicProfileRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkProfileWriteOptions
  ): Promise<TetiNetworkProfileResult> {
    assertNotAborted(options.signal);
    this.profileReplaceCalls.push({ input: structuredClone(input), options: { ...options } });
    return this.requireProfileResult();
  }

  async enrollClientInstance(
    input: TetiNetworkEnrollClientInstanceRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkClientInstanceDocument> {
    assertNotAborted(options.signal);
    this.enrollCalls.push(structuredClone(input));
    return this.requireClientMutation();
  }

  async revokeClientInstance(
    clientInstanceId: string,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkClientInstanceDocument> {
    assertNotAborted(options.signal);
    this.revokeCalls.push(clientInstanceId);
    return this.requireClientMutation();
  }

  async reportPresence(
    input: TetiNetworkPresenceReportRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkPresenceReportResponse> {
    assertNotAborted(signal);
    this.presenceReportCalls.push(structuredClone(input));
    if (this.errorValue !== null) throw this.errorValue;
    if (!this.presenceReportValue) throw new Error("Fake Network Presence report is not configured.");
    return structuredClone(this.presenceReportValue);
  }

  async getPresence(
    tetiId: string,
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkPresenceReadResponse> {
    assertNotAborted(signal);
    this.presenceReadCalls.push(tetiId);
    if (this.errorValue !== null) throw this.errorValue;
    const response = this.presenceReadValues.get(tetiId);
    return structuredClone(response ?? {
      schemaVersion: 1,
      tetiId,
      state: "offline",
      mode: null,
      activityMarker: null,
      reportedAt: null,
      observedAt: new Date(0).toISOString(),
      expiresAt: null,
      expiresInSeconds: 0
    });
  }

  async listRelationships(
    query: TetiNetworkRelationshipListQuery = {},
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipListPage> {
    assertNotAborted(signal);
    this.relationshipListCalls.push(structuredClone(query));
    if (this.errorValue !== null) throw this.errorValue;
    return structuredClone(this.relationshipListValue);
  }

  async getRelationship(
    relationshipId: string,
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult> {
    assertNotAborted(signal);
    this.relationshipGetCalls.push(relationshipId);
    if (this.errorValue !== null) throw this.errorValue;
    return this.requireRelationship(this.relationshipValues.get(relationshipId));
  }

  async getRelationshipWithPeer(
    peerTetiId: string,
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult> {
    assertNotAborted(signal);
    this.relationshipPeerCalls.push(peerTetiId);
    if (this.errorValue !== null) throw this.errorValue;
    return this.requireRelationship(this.relationshipPeerValues.get(peerTetiId));
  }

  async getRelationshipAuthorization(
    peerTetiId: string,
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipAuthorization> {
    assertNotAborted(signal);
    this.relationshipAuthorizationCalls.push(peerTetiId);
    if (this.errorValue !== null) throw this.errorValue;
    return structuredClone(this.relationshipAuthorizationValues.get(peerTetiId) ?? {
      schemaVersion: 1,
      peerTetiId,
      relationshipId: null,
      relationshipRevision: null,
      decision: "deny",
      reason: "not_found",
      evaluatedAt: new Date(0).toISOString()
    });
  }

  async getRelationshipSnapshot(
    query: TetiNetworkRelationshipSnapshotQuery = {},
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipSnapshotPage> {
    assertNotAborted(signal);
    this.relationshipSnapshotCalls.push(structuredClone(query));
    if (this.errorValue !== null) throw this.errorValue;
    return structuredClone(this.relationshipSnapshotValue);
  }

  async getRelationshipChanges(
    query: TetiNetworkRelationshipChangesQuery,
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipChangesPage> {
    assertNotAborted(signal);
    this.relationshipChangesCalls.push(structuredClone(query));
    if (this.errorValue !== null) throw this.errorValue;
    return structuredClone(this.relationshipChangesValue);
  }

  async requestRelationship(
    input: TetiNetworkRequestRelationshipRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult> {
    assertNotAborted(options.signal);
    this.relationshipRequestCalls.push({ input: structuredClone(input), options: { ...options } });
    if (this.errorValue !== null) throw this.errorValue;
    return this.requireRelationship(this.relationshipPeerValues.get(input.peerTetiId));
  }

  async mutateRelationship(
    relationshipId: string,
    command: TetiNetworkRelationshipCommand,
    input: TetiNetworkMutateRelationshipRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult> {
    assertNotAborted(options.signal);
    this.relationshipMutationCalls.push({
      relationshipId,
      command,
      input: structuredClone(input),
      options: { ...options }
    });
    if (this.errorValue !== null) throw this.errorValue;
    return this.requireRelationship(this.relationshipValues.get(relationshipId));
  }

  private requireIdentitySession(): TetiNetworkIdentitySession {
    if (this.errorValue !== null) throw this.errorValue;
    if (!this.identitySessionValue) throw new Error("Fake Network identity session is not configured.");
    return structuredClone(this.identitySessionValue);
  }

  private requireRelayBindingResult(): TetiNetworkRelayBindingResult {
    if (this.errorValue !== null) throw this.errorValue;
    if (!this.relayBindingResultValue) {
      throw new Error("Fake Network RelayBinding result is not configured.");
    }
    return structuredClone(this.relayBindingResultValue);
  }

  private requireClientMutation(): TetiNetworkClientInstanceDocument {
    if (this.errorValue !== null) throw this.errorValue;
    if (!this.clientMutationValue) throw new Error("Fake Network client mutation is not configured.");
    return structuredClone(this.clientMutationValue);
  }

  private requireProfileResult(): TetiNetworkProfileResult {
    if (this.errorValue !== null) throw this.errorValue;
    if (!this.profileResultValue) throw new Error("Fake Network PublicProfile is not configured.");
    return structuredClone(this.profileResultValue);
  }

  private requireRelationship(
    result: TetiNetworkRelationshipResult | undefined
  ): TetiNetworkRelationshipResult {
    if (result) return structuredClone(result);
    throw new TetiNetworkClientError({
      code: "RELATIONSHIP_NOT_FOUND",
      operation: "relationship_get",
      message: "The requested Relationship does not exist.",
      retryable: false,
      status: 404
    });
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Network request was cancelled.");
}
