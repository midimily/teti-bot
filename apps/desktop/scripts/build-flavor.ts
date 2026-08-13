export type TetiBuildType = "development" | "release";

/** Development is intentionally the safe default for every local build command. */
export function resolveTetiBuildType(value = process.env.TETI_BUILD_TYPE): TetiBuildType {
  const normalized = value?.trim().toLowerCase() || "development";
  if (normalized === "dev" || normalized === "development") return "development";
  if (normalized === "release") return "release";
  throw new Error("TETI_BUILD_TYPE must be development or release.");
}
