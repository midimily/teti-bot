export const TETI_NETWORK_PROTOCOL_VERSION = 1 as const;
export const TETI_NETWORK_MINIMUM_CONTRACT_REVISION = 6 as const;

export const TETI_NETWORK_CAPABILITIES = [
  "publicDirectory",
  "identity",
  "clientAuthentication",
  "presence",
  "publicProfile",
  "relationships",
  "relayBindings",
  "invites"
] as const;

export type TetiNetworkCapability = (typeof TETI_NETWORK_CAPABILITIES)[number];

export type TetiNetworkCapabilities = Record<TetiNetworkCapability, boolean>;

export interface TetiNetworkBootstrap {
  protocolVersion: number;
  contractRevision: number;
  service: {
    name: "teti-network";
    version: string;
  };
  serverTime: string;
  protocolSupport: {
    minimumSupportedVersion: number;
    supportedVersions: number[];
  };
  releasePolicy: TetiNetworkReleasePolicy;
  capabilities: TetiNetworkCapabilities;
  presencePolicy: TetiNetworkPresencePolicy;
}

export type TetiNetworkPresenceMode =
  | "collaborating"
  | "viewing_connect"
  | "online"
  | "background";

export type TetiNetworkPresenceActivityMarker = "collaboration_active" | null;

export type TetiNetworkPresencePolicy = Record<
  TetiNetworkPresenceMode,
  { reportEverySeconds: number; ttlSeconds: number }
>;

export interface TetiNetworkReleasePolicy {
  schemaVersion: 1;
  policyVersion: number;
  channel: "beta";
  minimumSupportedVersion: string;
  effectiveAt: string;
}

export type TetiNetworkPublicDirectorySort = "updated_desc" | "created_asc" | "id_asc";

export interface TetiNetworkPublicCapabilitySummary {
  schemaVersion: 1;
  platform: TetiNetworkPublicPlatform;
  category: string[];
  capabilityIds: string[];
  /** Revision 5 read-only compatibility field. Profile writes must omit it. */
  aiEnvironment: string[];
}

export interface TetiNetworkPublicProfile {
  revision: number;
  displayName: string | null;
  avatarUrl: string | null;
  summary: string | null;
  capabilitySummary: TetiNetworkPublicCapabilitySummary | null;
  updatedAt: string | null;
}

export type TetiNetworkPublicPlatform =
  | "macos"
  | "windows"
  | "linux"
  | "ios"
  | "android"
  | "other"
  | null;

export interface TetiNetworkPublicCapabilitySummaryWrite {
  schemaVersion: 1;
  platform: TetiNetworkPublicPlatform;
  category: string[];
  capabilityIds: string[];
}

export interface TetiNetworkPublicProfileFields {
  displayName: string | null;
  avatarUrl: string | null;
  summary: string | null;
  capabilitySummary: TetiNetworkPublicCapabilitySummaryWrite | null;
}

export interface TetiNetworkPublicProfileDocument {
  schemaVersion: 1;
  tetiId: string;
  revision: number;
  profile: TetiNetworkPublicProfileFields;
  isDiscoverable: boolean;
  updatedAt: string | null;
}

export interface TetiNetworkReplacePublicProfileRequest {
  schemaVersion: 1;
  expectedRevision: number;
  profile: TetiNetworkPublicProfileFields;
  isDiscoverable: boolean;
}

export type TetiNetworkProfileEtag = `"profile-r${number}"`;

export interface TetiNetworkProfileResult {
  document: TetiNetworkPublicProfileDocument;
  etag: TetiNetworkProfileEtag;
}

export interface TetiNetworkPublicNodeSummary {
  id: string;
  delivery: { address: string };
  profile: TetiNetworkPublicProfile;
  isDiscoverable: true;
  updatedAt: string;
}

export interface TetiNetworkPublicNode {
  id: string;
  identityPublicKey: string;
  delivery: {
    transport: "chatmail";
    address: string;
    publicKey: string | null;
  };
  profile: TetiNetworkPublicProfile;
  isDiscoverable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TetiNetworkPublicDirectoryQuery {
  limit?: number;
  sort?: TetiNetworkPublicDirectorySort;
  cursor?: string;
}

export interface TetiNetworkPublicDirectoryPage {
  items: TetiNetworkPublicNodeSummary[];
  page: {
    limit: number;
    returnedCount: number;
    nextCursor: string | null;
  };
  sort: TetiNetworkPublicDirectorySort;
}

export interface TetiNetworkPublicStats {
  activeIdentityCount: number;
  discoverableNodeCount: number;
  generatedAt: string;
}

export interface TetiNetworkCompatibilityRequirements {
  requiredProtocolVersion: number;
  minimumContractRevision: number;
  requiredCapabilities: readonly TetiNetworkCapability[];
}

export const BETA_035_NETWORK_REQUIREMENTS: TetiNetworkCompatibilityRequirements = Object.freeze({
  requiredProtocolVersion: TETI_NETWORK_PROTOCOL_VERSION,
  minimumContractRevision: TETI_NETWORK_MINIMUM_CONTRACT_REVISION,
  requiredCapabilities: Object.freeze([
    "publicDirectory",
    "publicProfile",
    "identity",
    "clientAuthentication",
    "presence",
    "relationships"
  ] as TetiNetworkCapability[])
});

export const BETA_034_NETWORK_REQUIREMENTS: TetiNetworkCompatibilityRequirements = Object.freeze({
  requiredProtocolVersion: TETI_NETWORK_PROTOCOL_VERSION,
  minimumContractRevision: 5,
  requiredCapabilities: Object.freeze([
    "publicDirectory",
    "publicProfile",
    "identity",
    "clientAuthentication",
    "presence"
  ] as TetiNetworkCapability[])
});

/** @deprecated Beta 0.3.4 requirements are retained only for contract regression tests. */
export const BETA_033_NETWORK_REQUIREMENTS = BETA_034_NETWORK_REQUIREMENTS;

export type TetiNetworkEd25519PublicKey = `ed25519:${string}`;
export type TetiNetworkEd25519PrivateSeed = `ed25519-seed:${string}`;
export type TetiNetworkEd25519Signature = `ed25519:${string}`;

export interface TetiNetworkSigningKey {
  readonly publicKey: TetiNetworkEd25519PublicKey;
  sign(message: string): TetiNetworkEd25519Signature;
}

export interface TetiNetworkDeliveryIdentity {
  address: string;
  publicKey: string | null;
}

export interface TetiNetworkIdentityDocument {
  tetiId: string;
  identityPublicKey: TetiNetworkEd25519PublicKey;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface TetiNetworkClientInstanceDocument {
  id: string;
  publicKey: TetiNetworkEd25519PublicKey;
  platform: string;
  appVersion: string;
  status: "active" | "revoked";
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface TetiNetworkIdentitySession {
  identity: TetiNetworkIdentityDocument;
  clientInstance: TetiNetworkClientInstanceDocument;
  delivery: TetiNetworkDeliveryIdentity;
}

export interface TetiNetworkRegisterIdentityRequest {
  schemaVersion: 1;
  identityPublicKey: TetiNetworkEd25519PublicKey;
  clientInstance: {
    publicKey: TetiNetworkEd25519PublicKey;
    platform: string;
    appVersion: string;
  };
  identityAuthorization: TetiNetworkEd25519Signature;
  delivery: TetiNetworkDeliveryIdentity;
}

export interface TetiNetworkAdoptIdentityRequest extends TetiNetworkRegisterIdentityRequest {
  tetiId: string;
  adoptionGrant: string;
}

export interface TetiNetworkEnrollClientInstanceRequest {
  schemaVersion: 1;
  clientInstance: {
    publicKey: TetiNetworkEd25519PublicKey;
    platform: string;
    appVersion: string;
  };
  identityAuthorization: TetiNetworkEd25519Signature;
  clientProof: TetiNetworkEd25519Signature;
}

export interface TetiNetworkAuthenticatedSigner {
  clientInstanceId: string;
  signingKey: TetiNetworkSigningKey;
}

export interface TetiNetworkPresenceReportRequest {
  schemaVersion: 1;
  sessionId: string;
  sequence: number;
  mode: TetiNetworkPresenceMode;
  activityMarker: TetiNetworkPresenceActivityMarker;
}

export interface TetiNetworkPresenceReportResponse extends TetiNetworkPresenceReportRequest {
  tetiId: string;
  reportedAt: string;
  expiresAt: string;
  expiresInSeconds: number;
}

export type TetiNetworkPresenceReadResponse =
  | {
      schemaVersion: 1;
      tetiId: string;
      state: "online";
      mode: TetiNetworkPresenceMode;
      activityMarker: TetiNetworkPresenceActivityMarker;
      reportedAt: string;
      observedAt: string;
      expiresAt: string;
      expiresInSeconds: number;
    }
  | {
      schemaVersion: 1;
      tetiId: string;
      state: "offline";
      mode: null;
      activityMarker: null;
      reportedAt: null;
      observedAt: string;
      expiresAt: null;
      expiresInSeconds: 0;
    };

export type TetiNetworkRelationshipState =
  | "requested"
  | "confirmed"
  | "rejected"
  | "blocked"
  | "revoked";

export type TetiNetworkRelationshipDirection = "outgoing" | "incoming";
export type TetiNetworkRelationshipBlockedBy = "self" | "peer" | null;
export type TetiNetworkRelationshipCommand = "accept" | "reject" | "block" | "revoke";

export interface TetiNetworkRelationshipDocument {
  schemaVersion: 1;
  id: string;
  revision: number;
  state: TetiNetworkRelationshipState;
  peerTetiId: string;
  requesterTetiId: string;
  addresseeTetiId: string;
  direction: TetiNetworkRelationshipDirection;
  blockedBy: TetiNetworkRelationshipBlockedBy;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
}

export interface TetiNetworkRelationshipListQuery {
  limit?: number;
  cursor?: string;
}

export interface TetiNetworkRelationshipListPage {
  items: TetiNetworkRelationshipDocument[];
  page: {
    limit: number;
    returnedCount: number;
    nextCursor: string | null;
  };
}

export interface TetiNetworkRequestRelationshipRequest {
  schemaVersion: 1;
  peerTetiId: string;
  expectedRevision: number;
}

export interface TetiNetworkMutateRelationshipRequest {
  schemaVersion: 1;
  expectedRevision: number;
}

export type TetiNetworkRelationshipEtag = `"relationship-r${number}"`;

export interface TetiNetworkRelationshipResult {
  document: TetiNetworkRelationshipDocument;
  etag: TetiNetworkRelationshipEtag;
}

export interface TetiNetworkWriteOptions {
  idempotencyKey: string;
  /** Exact bytes retained for a persisted write retry. */
  rawBody?: string;
  signal?: AbortSignal;
}

export interface TetiNetworkProfileWriteOptions extends TetiNetworkWriteOptions {
  /** Strong ETag returned by GET /v1/profile/self and retained with a pending mutation. */
  ifMatch: TetiNetworkProfileEtag;
}

export interface TetiNetworkRelationshipWriteOptions extends TetiNetworkWriteOptions {
  /** Strong ETag retained with the exact pending Relationship command. */
  ifMatch: TetiNetworkRelationshipEtag;
}

export interface TetiNetworkClient {
  getBootstrap(signal?: AbortSignal): Promise<TetiNetworkBootstrap>;
  getPublicNode(tetiId: string, signal?: AbortSignal): Promise<TetiNetworkPublicNode>;
  listPublicNodes(
    query?: TetiNetworkPublicDirectoryQuery,
    signal?: AbortSignal
  ): Promise<TetiNetworkPublicDirectoryPage>;
  getPublicStats(signal?: AbortSignal): Promise<TetiNetworkPublicStats>;
  registerIdentity(
    input: TetiNetworkRegisterIdentityRequest,
    pendingClient: TetiNetworkSigningKey,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkIdentitySession>;
  adoptIdentity(
    input: TetiNetworkAdoptIdentityRequest,
    pendingClient: TetiNetworkSigningKey,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkIdentitySession>;
  getIdentitySelf(
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkIdentitySession>;
  getProfileSelf(
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkProfileResult>;
  replaceProfileSelf(
    input: TetiNetworkReplacePublicProfileRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkProfileWriteOptions
  ): Promise<TetiNetworkProfileResult>;
  enrollClientInstance(
    input: TetiNetworkEnrollClientInstanceRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkClientInstanceDocument>;
  revokeClientInstance(
    clientInstanceId: string,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkClientInstanceDocument>;
  reportPresence(
    input: TetiNetworkPresenceReportRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkPresenceReportResponse>;
  getPresence(
    tetiId: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkPresenceReadResponse>;
  listRelationships(
    query: TetiNetworkRelationshipListQuery | undefined,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipListPage>;
  getRelationship(
    relationshipId: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult>;
  getRelationshipWithPeer(
    peerTetiId: string,
    authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult>;
  requestRelationship(
    input: TetiNetworkRequestRelationshipRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult>;
  mutateRelationship(
    relationshipId: string,
    command: TetiNetworkRelationshipCommand,
    input: TetiNetworkMutateRelationshipRequest,
    authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult>;
}
