import assert from "node:assert/strict";
import test from "node:test";
import {
  environmentScanToPublicProfile,
  filterPublicEnvironmentProfile,
  scanEnvironment
} from "./scanner.ts";
import type { EnvironmentDetector } from "./types.ts";

const fixedNow = "2026-07-11T00:00:00.000Z";

test("detects mock AI tools", async () => {
  const scan = await scanEnvironment({
    platform: "macOS",
    device: macStudioDevice(),
    now: () => fixedNow,
    detectors: [
      mockDetector("claude-code", "Claude Code"),
      mockDetector("cursor", "Cursor")
    ]
  });

  assert.equal(scan.platform, "macOS");
  assert.equal(scan.timestamp, fixedNow);
  assert.deepEqual(
    scan.aiTools.map((tool) => tool.name),
    ["Claude Code", "Cursor"]
  );
});

test("detects macOS host metadata safely", async () => {
  const scan = await scanEnvironment({
    platform: "macOS",
    device: macStudioDevice(),
    now: () => fixedNow,
    detectors: []
  });

  assert.deepEqual(scan.device, {
    os: {
      name: "macOS",
      version: "15.5"
    },
    hardware: {
      vendor: "Apple",
      model: "Mac Studio",
      architecture: "arm64"
    }
  });
});

test("location metadata is optional", async () => {
  const withoutLocation = await scanEnvironment({
    platform: "macOS",
    device: macStudioDevice(),
    now: () => fixedNow,
    detectors: []
  });
  const withLocation = await scanEnvironment({
    platform: "macOS",
    device: macStudioDevice(),
    location: {
      country: "US",
      city: "San Francisco"
    },
    now: () => fixedNow,
    detectors: []
  });

  assert.equal(withoutLocation.location, undefined);
  assert.deepEqual(withLocation.location, {
    country: "US",
    city: "San Francisco"
  });
});

test("serializes public environment profile", async () => {
  const scan = await scanEnvironment({
    platform: "macOS",
    device: macStudioDevice(),
    now: () => fixedNow,
    detectors: [mockDetector("codex", "Codex")]
  });

  assert.deepEqual(environmentScanToPublicProfile(scan), {
    platform: "macOS",
    device: {
      os: {
        name: "macOS",
        version: "15.5"
      },
      hardware: {
        vendor: "Apple",
        model: "Mac Studio",
        architecture: "arm64"
      }
    },
    aiEnvironment: ["Codex"],
    lastSeen: fixedNow
  });
});

test("privacy filtering rejects private host metadata", () => {
  assert.throws(() => filterPublicEnvironmentProfile({
    platform: "macOS",
    device: macStudioDevice(),
    aiEnvironment: ["Claude Code", "Cursor"],
    lastSeen: fixedNow,
    hostname: "private-host",
    ip: "192.0.2.10",
    macAddress: "00:00:00:00:00:00",
    username: "local-user",
    serialNumber: "secret",
    filesystemPath: "/Users/local-user/project"
  }), /must not be published/);
});

test("privacy filtering keeps allowed public host and location metadata", () => {
  const profile = filterPublicEnvironmentProfile({
    platform: "macOS",
    device: macStudioDevice(),
    location: {
      country: "US",
      city: "San Francisco"
    },
    aiEnvironment: ["Claude Code", "Cursor"],
    lastSeen: fixedNow
  });

  assert.deepEqual(profile, {
    platform: "macOS",
    device: {
      os: {
        name: "macOS",
        version: "15.5"
      },
      hardware: {
        vendor: "Apple",
        model: "Mac Studio",
        architecture: "arm64"
      }
    },
    location: {
      country: "US",
      city: "San Francisco"
    },
    aiEnvironment: ["Claude Code", "Cursor"],
    lastSeen: fixedNow
  });
});

function mockDetector(id: string, name: string): EnvironmentDetector {
  return {
    id,
    async detect() {
      return [{ id, name, source: "mock" }];
    }
  };
}

function macStudioDevice() {
  return {
    os: {
      name: "macOS",
      version: "15.5"
    },
    hardware: {
      vendor: "Apple",
      model: "Mac Studio",
      architecture: "arm64"
    }
  };
}
