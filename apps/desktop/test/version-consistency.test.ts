import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const desktopRoot = new URL("..", import.meta.url);
const repoRoot = new URL("../../..", import.meta.url);

test("application version sources and generated lock metadata stay aligned", async () => {
  const [rootPackage, desktopPackage, desktopLock, tauriConfig, cargoToml, cargoLock] = await Promise.all([
    readJson(new URL("package.json", repoRoot)),
    readJson(new URL("package.json", desktopRoot)),
    readJson(new URL("package-lock.json", desktopRoot)),
    readJson(new URL("src-tauri/tauri.conf.json", desktopRoot)),
    readFile(new URL("src-tauri/Cargo.toml", desktopRoot), "utf8"),
    readFile(new URL("src-tauri/Cargo.lock", desktopRoot), "utf8")
  ]);

  const cargoVersion = packageVersionFromCargo(cargoToml, "teti-desktop");
  const cargoLockVersion = packageVersionFromCargo(cargoLock, "teti-desktop");
  const versions = [
    rootPackage.version,
    desktopPackage.version,
    desktopLock.version,
    packageRecord(desktopLock).version,
    tauriConfig.version,
    cargoVersion,
    cargoLockVersion
  ];

  assert.equal(typeof versions[0], "string");
  assert.match(versions[0] as string, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(versions, Array(versions.length).fill(versions[0]));
});

async function readJson(url: URL): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}

function packageRecord(lock: Record<string, unknown>): Record<string, unknown> {
  const packages = lock.packages;
  assert.equal(typeof packages, "object");
  assert.notEqual(packages, null);
  const root = (packages as Record<string, unknown>)[""];
  assert.equal(typeof root, "object");
  assert.notEqual(root, null);
  return root as Record<string, unknown>;
}

function packageVersionFromCargo(contents: string, packageName: string): string {
  const blocks = contents.split(/\n(?=\[\[package\]\]|\[package\])/);
  const block = blocks.find((candidate) => candidate.includes(`name = "${packageName}"`));
  assert.ok(block, `Missing Cargo package ${packageName}.`);
  const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(version, `Missing Cargo version for ${packageName}.`);
  return version;
}
