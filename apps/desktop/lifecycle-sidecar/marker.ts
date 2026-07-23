import { readFile, writeFile } from "node:fs/promises";
import type { TetiProfile } from "./profile.ts";

export type CreationMarkerStage =
  | "not_started"
  | "provisioning"
  | "identity_created"
  | "persisting"
  | "persisted"
  | "registering_discovery"
  | "complete"
  | "failed_recoverable"
  | "failed_fatal";

export interface CreationMarker {
  version: 1;
  stage: CreationMarkerStage;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  publicTetiId?: string;
  publicAddress?: string;
  errorCode?: string;
  errorMessage?: string;
  failureDomain?: "chatmail" | "registry" | "local";
  failureStage?: string;
}

export async function readCreationMarker(profile: TetiProfile): Promise<CreationMarker | null> {
  try {
    return JSON.parse(await readFile(profile.markerPath, "utf8")) as CreationMarker;
  } catch {
    return null;
  }
}

export async function writeCreationMarker(
  profile: TetiProfile,
  marker: Omit<CreationMarker, "version" | "updatedAt"> & Partial<Pick<CreationMarker, "updatedAt">>
): Promise<CreationMarker> {
  const value: CreationMarker = {
    version: 1,
    updatedAt: marker.updatedAt ?? new Date().toISOString(),
    ...marker
  };
  await writeFile(profile.markerPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

export function isUnsafeIncompleteMarker(marker: CreationMarker | null): boolean {
  return Boolean(
    marker &&
      ![
        "not_started",
        "complete",
        "failed_recoverable",
        "failed_fatal"
      ].includes(marker.stage)
  );
}
