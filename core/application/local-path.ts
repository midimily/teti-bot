export type LocalPathPlatform = "macos" | "windows";

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/](?![\\/])/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Validates a local filesystem boundary without normalizing an attacker-owned
 * value. Network shares, device paths, drive-relative paths, and lexical
 * traversal are deliberately excluded on Windows.
 */
export function isSafeAbsoluteLocalPath(
  value: unknown,
  platform: LocalPathPlatform = currentLocalPathPlatform()
): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || CONTROL_CHARACTER.test(value)
    || value.trim() !== value) return false;

  if (platform === "windows") {
    if (!WINDOWS_DRIVE_ABSOLUTE.test(value)
      || value.startsWith("\\\\")
      || value.startsWith("//")
      || value.slice(2).includes(":")) return false;
    return hasCanonicalSegments(value.slice(3).split(/[\\/]/));
  }

  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return false;
  return hasCanonicalSegments(value.slice(1).split("/"));
}

export function localPathBasename(
  value: string,
  platform: LocalPathPlatform = currentLocalPathPlatform()
): string {
  const parts = platform === "windows" ? value.split(/[\\/]/) : value.split("/");
  return parts.at(-1) ?? "";
}

export function currentLocalPathPlatform(
  hostPlatform: NodeJS.Platform = process.platform
): LocalPathPlatform {
  return hostPlatform === "win32" ? "windows" : "macos";
}

function hasCanonicalSegments(segments: readonly string[]): boolean {
  return segments.every((segment, index) =>
    (segment.length > 0 || index === segments.length - 1)
    && segment !== "."
    && segment !== ".."
  );
}
