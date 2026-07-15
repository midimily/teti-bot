import type {
  MatchTetisInput,
  TetiCompatibilityMatch,
  TetiIdentity,
  TetiPublicProfile
} from "./types.ts";

export function matchTetis(input: MatchTetisInput): TetiCompatibilityMatch[] {
  const minScore = input.minScore ?? 0;

  return input.remoteTetis
    .map((identity) => ({
      identity,
      ...scoreCompatibility(input.localProfile, identity)
    }))
    .filter((match) => match.score >= minScore)
    .sort((a, b) => b.score - a.score || a.identity.id.localeCompare(b.identity.id));
}

export function scoreCompatibility(
  localProfile: TetiPublicProfile,
  remoteIdentity: TetiIdentity
): Pick<TetiCompatibilityMatch, "score" | "reasons"> {
  const reasons: string[] = [];
  let score = 0;

  const remoteProfile = remoteIdentity.publicProfile ?? {};
  const localPlatform = normalizedString(localProfile.platform);
  const remotePlatform = normalizedString(remoteProfile.platform);

  if (localPlatform && remotePlatform && localPlatform === remotePlatform) {
    score += 20;
    reasons.push(`same platform: ${remoteProfile.platform}`);
  }

  const aiMatches = intersection(
    normalizedStringArray(localProfile.aiEnvironment),
    normalizedStringArray(remoteProfile.aiEnvironment)
  );
  if (aiMatches.length > 0) {
    score += Math.min(50, aiMatches.length * 25);
    reasons.push(`shared AI environment: ${aiMatches.join(", ")}`);
  }

  const categoryMatches = intersection(
    normalizedStringArray(localProfile.category),
    normalizedStringArray(remoteProfile.category)
  );
  if (categoryMatches.length > 0) {
    score += Math.min(20, categoryMatches.length * 10);
    reasons.push(`shared category: ${categoryMatches.join(", ")}`);
  }

  if (remoteIdentity.publicKey) {
    score += 10;
    reasons.push("public key available");
  }

  return {
    score: Math.min(score, 100),
    reasons
  };
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : undefined;
}

function normalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map(normalizedString)
        .filter((item): item is string => typeof item === "string")
    )
  ];
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

