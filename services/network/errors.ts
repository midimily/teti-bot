export type TetiNetworkErrorCode =
  | "NETWORK_UNAVAILABLE"
  | "NETWORK_TIMEOUT"
  | "NETWORK_UNAUTHORIZED"
  | "NETWORK_CLIENT_REVOKED"
  | "NETWORK_CONFLICT"
  | "NETWORK_INVALID_RESPONSE"
  | "NETWORK_REQUEST_INVALID"
  | "NETWORK_REQUEST_REJECTED"
  | "REQUEST_REPLAYED"
  | "IDEMPOTENCY_CONFLICT"
  | "PRESENCE_SEQUENCE_STALE"
  | "PROFILE_REVISION_CONFLICT"
  | "RELATIONSHIP_TRANSITION_INVALID"
  | "RELATIONSHIP_BLOCKED"
  | "RELATIONSHIP_REVISION_CONFLICT"
  | "RELAY_NOT_FOUND"
  | "RELAY_UNAVAILABLE"
  | "RELAY_BINDING_NOT_FOUND"
  | "RELAY_BINDING_CONFLICT"
  | "MAILBOX_ALREADY_BOUND"
  | "RELAY_BINDING_TRANSITION_INVALID"
  | "RELAY_BINDING_REVISION_CONFLICT"
  | "RELAY_BINDING_ADOPTION_DENIED"
  | "IDENTITY_NOT_FOUND"
  | "IDENTITY_ALREADY_EXISTS"
  | "RELATIONSHIP_NOT_FOUND"
  | "INVITE_EXPIRED"
  | "INVITE_USED"
  | "RATE_LIMITED"
  | "SERVER_UNAVAILABLE"
  | "PROTOCOL_UNSUPPORTED";

export type TetiNetworkOperation =
  | "bootstrap"
  | "public_node"
  | "public_directory"
  | "public_stats"
  | "identity_register"
  | "identity_adopt"
  | "identity_self"
  | "client_enroll"
  | "client_revoke"
  | "presence_report"
  | "presence_read"
  | "profile_self"
  | "profile_replace"
  | "relationship_list"
  | "relationship_get"
  | "relationship_get_by_peer"
  | "relationship_authorization"
  | "relationship_reconciliation_snapshot"
  | "relationship_reconciliation_changes"
  | "relationship_request"
  | "relationship_accept"
  | "relationship_reject"
  | "relationship_block"
  | "relationship_revoke"
  | "relay_list"
  | "relay_binding_self"
  | "relay_binding_create"
  | "relay_binding_adopt"
  | "relay_binding_activate"
  | "relay_binding_revoke";

export interface TetiNetworkClientErrorOptions {
  code: TetiNetworkErrorCode;
  operation: TetiNetworkOperation;
  message: string;
  retryable: boolean;
  requestId?: string;
  retryAfterMs?: number;
  status?: number;
}

export class TetiNetworkClientError extends Error {
  readonly code: TetiNetworkErrorCode;
  readonly operation: TetiNetworkOperation;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  /** Retained for diagnostics and tests; UI and domain code must branch on code. */
  readonly status?: number;

  constructor(options: TetiNetworkClientErrorOptions) {
    super(options.message);
    this.name = "TetiNetworkClientError";
    this.code = options.code;
    this.operation = options.operation;
    this.retryable = options.retryable;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }
}
