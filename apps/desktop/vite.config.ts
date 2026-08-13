import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTetiBuildType } from "./scripts/build-flavor.ts";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const packageVersion = readPackageVersion();
const buildTimestamp = resolveBuildTimestamp();
const buildType = resolveTetiBuildType();

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true
  },
  // TETI_* belongs to the Node Runtime. The WebView receives only explicit VITE_* values.
  envPrefix: ["VITE_"],
  define: {
    __TETI_APP_VERSION__: JSON.stringify(packageVersion),
    __TETI_BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
    __TETI_BUILD_TYPE__: JSON.stringify(buildType)
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true
  }
});

function readPackageVersion(): string {
  const value = JSON.parse(readFileSync(resolve(desktopRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) {
    throw new Error("Desktop package version must use major.minor.patch.");
  }
  return value.version;
}

function resolveBuildTimestamp(): string {
  const input = process.env.TETI_BUILD_TIMESTAMP ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(input))) throw new Error("TETI_BUILD_TIMESTAMP must be an ISO timestamp.");
  return new Date(input).toISOString();
}
