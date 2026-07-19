import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PeerConnectionDto } from "../src/lifecycle-bridge/protocol.ts";
import {
  REMOTE_TETI_HEARTBEAT_FRESH_MS,
  mapRemoteTetiReachability,
  remoteTetiReachabilityLabel
} from "../src/connections/remote-teti-avatar.ts";

const now = Date.parse("2026-07-19T04:00:00.000Z");

test("a fresh confirmed peer maps to the blue online presentation", () => {
  const connection = confirmedPeer(new Date(now - REMOTE_TETI_HEARTBEAT_FRESH_MS + 1).toISOString());

  const reachability = mapRemoteTetiReachability(connection, now);

  assert.equal(reachability, "reachable");
  assert.equal(remoteTetiReachabilityLabel(reachability), "在线");
});

test("a stale confirmed peer maps to the gray offline presentation", () => {
  const connection = confirmedPeer(new Date(now - REMOTE_TETI_HEARTBEAT_FRESH_MS).toISOString());

  const reachability = mapRemoteTetiReachability(connection, now);

  assert.equal(reachability, "unreachable");
  assert.equal(remoteTetiReachabilityLabel(reachability), "离线");
});

test("missing, invalid, and non-confirmed heartbeat state fail closed to offline", () => {
  const cases = [
    confirmedPeer(undefined),
    confirmedPeer("not-a-date"),
    { ...confirmedPeer(new Date(now).toISOString()), state: "Requested" as const }
  ];

  for (const connection of cases) {
    assert.equal(mapRemoteTetiReachability(connection, now), "unreachable");
  }
});

test("different peer cards derive reachability independently", () => {
  const peers = [
    confirmedPeer(new Date(now - 1_000).toISOString(), "online-peer"),
    confirmedPeer(new Date(now - 60_000).toISOString(), "offline-peer")
  ];

  assert.deepEqual(
    peers.map((peer) => mapRemoteTetiReachability(peer, now)),
    ["reachable", "unreachable"]
  );
});

test("remote avatar uses one transparent source mask with no animation or status dot", async () => {
  const [component, app, styles, asset] = await Promise.all([
    readFile(new URL("../src/connections/remote-teti-avatar.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/remote-teti-silhouette.png", import.meta.url))
  ]);
  const avatarStyles = cssBlock(styles, ".teti-remote-avatar");

  assert.equal(asset.readUInt32BE(16), 929);
  assert.equal(asset.readUInt32BE(20), 816);
  assert.equal(asset[25], 4, "PNG should use grayscale plus alpha for a reusable mask");
  assert.match(component, /remote-teti-silhouette\.png/);
  assert.match(component, /aria-hidden", "true"/);
  assert.match(avatarStyles, /mask-image/);
  assert.doesNotMatch(avatarStyles, /animation|box-shadow|border-radius/);
  assert.match(styles, /--teti-remote-reachable:\s*var\(--teti-blue-primary\)/);
  assert.match(styles, /--teti-remote-unreachable:\s*#aebdca/);
  assert.doesNotMatch(app, /createElement\(Radio/);
});

test("confirmed cards retain relationship and AI status while the brand stays isolated", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(app, /row\.prepend\(createRemoteTetiAvatar\(\{ reachability, size: 28 \}\)\)/);
  assert.match(app, /relationship\.textContent = "已建联"/);
  assert.match(app, /`\[对方\$\{remoteTetiReachabilityLabel\(reachability\)\}\]`/);
  assert.match(app, /state\.append\(presence, createRemoteAiStatus\(connection\.remoteAiStatus\)\)/);
  assert.match(app, /const brand = createTetiBotBrandLink\(\{ ownerDocument: header\.ownerDocument \}\)/);
  assert.doesNotMatch(app, /teti-brand-dot/);
  assert.match(
    styles,
    /\.teti-connection-row\.is-confirmed \.teti-connection-state\s*\{[\s\S]*width:\s*max-content;[\s\S]*justify-self:\s*end;[\s\S]*white-space:\s*nowrap;/
  );
});

function confirmedPeer(
  lastHeartbeatReceivedAt?: string,
  requestId = "request-1"
): PeerConnectionDto {
  return {
    requestId,
    state: "Confirmed",
    direction: "outgoing",
    remoteTetiId: `teti_${requestId.padEnd(9, "0").slice(0, 9)}`,
    remoteAddress: `${requestId.padEnd(9, "0").slice(0, 9)}@mail.seep.im`,
    createdAt: "2026-07-19T03:00:00.000Z",
    updatedAt: "2026-07-19T03:00:00.000Z",
    lastHeartbeatReceivedAt
  };
}

function cssBlock(styles: string, selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} should exist`);
  const end = styles.indexOf("}\n", start);
  assert.notEqual(end, -1, `${selector} should have a closing brace`);
  return styles.slice(start, end + 1);
}
