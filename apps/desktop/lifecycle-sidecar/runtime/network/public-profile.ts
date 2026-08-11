import type { TetiAccount } from "../../../../../core/account/model.ts";
import type { CallableAgent } from "../../../../../core/callability/types.ts";
import type { DesiredTetiNetworkPublicProfile } from "../../../../../services/network/profile-service.ts";
import type { TetiNetworkPublicPlatform } from "../../../../../services/network/types.ts";

const PUBLIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Privacy boundary: Presence, resources, tasks and Passport data are not inputs. */
export function projectNetworkPublicProfile(
  account: TetiAccount,
  callableAgents: readonly CallableAgent[]
): DesiredTetiNetworkPublicProfile {
  return {
    profile: {
      displayName: boundedText(account.displayName, 80),
      avatarUrl: null,
      summary: null,
      capabilitySummary: {
        schemaVersion: 1,
        platform: publicPlatform(account.publicProfile.platform),
        category: canonicalSlugs(account.publicProfile.category, 8),
        capabilityIds: canonicalSlugs(callableAgents.flatMap((agent) => agent.capabilityIds), 32)
      }
    },
    // Existing Beta identities were public Network identities. This flag is
    // deliberately independent from confirmed-peer PassportSharingPolicy.
    isDiscoverable: true
  };
}

function publicPlatform(value: string): TetiNetworkPublicPlatform {
  const normalized = value.trim().toLowerCase();
  if (normalized === "macos" || normalized === "mac os" || normalized === "darwin") return "macos";
  if (normalized === "windows" || normalized === "win32") return "windows";
  if (normalized === "linux") return "linux";
  if (normalized === "ios") return "ios";
  if (normalized === "android") return "android";
  return "other";
}

function canonicalSlugs(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => PUBLIC_SLUG.test(value)))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit);
}

function boundedText(value: string | undefined, maxLength: number): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.slice(0, maxLength) : null;
}
