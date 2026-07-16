export interface TetiPublicProfile {
  platform?: string;
  category?: string[];
  aiEnvironment?: string[];
  [key: string]: unknown;
}

export interface TetiIdentity {
  id: string;
  address: string;
  displayName?: string;
  publicKey?: string;
  publicProfile: TetiPublicProfile;
  createdAt?: string;
  updatedAt?: string;
}

export interface DiscoverTetisInput {
  limit?: number;
}

export interface TetiProfileQuery {
  id: string;
}

export interface MatchTetisInput {
  localProfile: TetiPublicProfile;
  remoteTetis: TetiIdentity[];
  minScore?: number;
}

export interface TetiCompatibilityMatch {
  identity: TetiIdentity;
  score: number;
  reasons: string[];
}

export interface ConnectionRequestDraft {
  to: {
    id: string;
    address: string;
    publicKey?: string;
  };
  from: {
    id: string;
    address: string;
  };
  intent: "connect";
  publicContext?: Record<string, unknown>;
}
