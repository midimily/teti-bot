import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PassportConnectionSnapshot } from "../../../core/passport/snapshot.ts";
import { toConnectionCardViewModel } from "../src/passport/view-model.ts";

const now = Date.parse("2026-07-19T04:00:00.000Z");
const remoteHeartbeatFreshMs = 20_000;
const remoteHeartbeatOfflineMs = 60_000;

test("a fresh confirmed peer maps to the blue online presentation", () => {
  const connection = confirmedPeer(new Date(now - remoteHeartbeatFreshMs + 1).toISOString());
  const viewModel = toConnectionCardViewModel(connection, new Date(now));
  assert.equal(viewModel.reachability, "reachable");
  assert.equal(viewModel.reachabilityLabel, "在线");
});

test("a briefly stale confirmed peer maps to the checking presentation", () => {
  const connection = confirmedPeer(new Date(now - remoteHeartbeatFreshMs).toISOString());
  const viewModel = toConnectionCardViewModel(connection, new Date(now));
  assert.equal(viewModel.reachability, "checking");
  assert.equal(viewModel.reachabilityLabel, "状态检测中");
});

test("a heartbeat beyond the grace window maps to the gray offline presentation", () => {
  const connection = confirmedPeer(new Date(now - remoteHeartbeatOfflineMs).toISOString());
  const viewModel = toConnectionCardViewModel(connection, new Date(now));
  assert.equal(viewModel.reachability, "unreachable");
  assert.equal(viewModel.reachabilityLabel, "离线");
});

test("a newly confirmed peer without a heartbeat gets one bounded checking window", () => {
  const recent = {
    ...confirmedPeer(undefined),
    confirmedAt: new Date(now - 1_000).toISOString(),
    updatedAt: new Date(now - 1_000).toISOString()
  };
  assert.equal(toConnectionCardViewModel(recent, new Date(now)).reachability, "checking");

  const expired = {
    ...recent,
    confirmedAt: new Date(now - remoteHeartbeatOfflineMs).toISOString(),
    updatedAt: new Date(now - remoteHeartbeatOfflineMs).toISOString()
  };
  assert.equal(toConnectionCardViewModel(expired, new Date(now)).reachability, "unreachable");
});

test("invalid, future, and non-confirmed heartbeat state fail closed to offline", () => {
  const cases = [
    confirmedPeer("not-a-date"),
    confirmedPeer(new Date(now + 1_000).toISOString()),
    { ...confirmedPeer(new Date(now).toISOString()), connectionState: "Requested" as const }
  ];

  for (const connection of cases) {
    assert.equal(toConnectionCardViewModel(connection, new Date(now)).reachability, "unreachable");
  }
});

test("different peer cards derive reachability independently", () => {
  const peers = [
    confirmedPeer(new Date(now - 1_000).toISOString(), "online-peer"),
    confirmedPeer(new Date(now - 60_000).toISOString(), "offline-peer")
  ];

  assert.deepEqual(
    peers.map((peer) => toConnectionCardViewModel(peer, new Date(now)).reachability),
    ["reachable", "unreachable"]
  );
});

test("remote avatar uses an accessible blue silhouette with a static yellow checking dot", async () => {
  const [component, app, styles, asset] = await Promise.all([
    readFile(new URL("../src/connections/remote-teti-avatar.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/remote-teti-silhouette.png", import.meta.url))
  ]);
  const avatarStyles = cssBlock(styles, ".teti-remote-avatar");
  const silhouetteStyles = cssBlock(styles, ".teti-remote-avatar-silhouette");
  const checkingStyles = cssBlock(styles, ".teti-remote-avatar.is-checking");
  const indicatorStyles = cssBlock(styles, ".teti-remote-avatar-indicator");

  assert.equal(asset.readUInt32BE(16), 929);
  assert.equal(asset.readUInt32BE(20), 816);
  assert.equal(asset[25], 4, "PNG should use grayscale plus alpha for a reusable mask");
  assert.match(component, /remote-teti-silhouette\.png/);
  assert.match(component, /setAttribute\("role", "img"\)/);
  assert.match(component, /aria-label/);
  assert.match(component, /teti-remote-avatar-silhouette/);
  assert.match(component, /teti-remote-avatar-indicator/);
  assert.doesNotMatch(avatarStyles, /mask-image/);
  assert.match(silhouetteStyles, /mask-image/);
  assert.match(checkingStyles, /var\(--teti-remote-reachable\)/);
  assert.match(indicatorStyles, /position:\s*absolute/);
  assert.match(indicatorStyles, /background:\s*var\(--teti-remote-checking\)/);
  assert.doesNotMatch(indicatorStyles, /animation/);
  assert.match(styles, /--teti-remote-reachable:\s*var\(--teti-blue-primary\)/);
  assert.match(styles, /--teti-remote-unreachable:\s*#aebdca/);
  assert.doesNotMatch(app, /createElement\(Radio/);
});

test("confirmed cards use only the avatar for presence while retaining AI status", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(app, /row\.prepend\(createRemoteTetiAvatar\(\{/);
  assert.match(app, /label:\s*connection\.reachabilityLabel/);
  assert.doesNotMatch(app, /teti-connection-presence|teti-connection-relationship|teti-connection-reachability/);
  assert.match(app, /state\.append\(createRemotePassport\(connection\.passport\)\)/);
  assert.match(app, /connection\.compatibility !== "compatible"/);
  assert.match(app, /setAttribute\("role", "alertdialog"\)/);
  assert.match(app, /本机 Teti 的所有功能均暂停使用/);
  assert.doesNotMatch(app, /teti-protocol-blocker-button/);
  assert.match(app, /const brand = createTetiBotBrandLink\(\{ ownerDocument: header\.ownerDocument \}\)/);
  assert.doesNotMatch(app, /teti-brand-dot/);
  assert.match(
    styles,
    /\.teti-connection-row\.is-confirmed \.teti-connection-state\s*\{[\s\S]*width:\s*max-content;[\s\S]*justify-self:\s*end;[\s\S]*white-space:\s*nowrap;/
  );
});

function confirmedPeer(
  lastSeen?: string,
  requestId = "request-1"
): PassportConnectionSnapshot {
  return {
    requestId,
    connectionState: "Confirmed",
    direction: "outgoing",
    identity: {
      tetiId: `teti_${requestId.padEnd(9, "0").slice(0, 9)}`,
      address: `${requestId.padEnd(9, "0").slice(0, 9)}@mail.seep.im`
    },
    createdAt: "2026-07-19T03:00:00.000Z",
    updatedAt: "2026-07-19T03:00:00.000Z",
    lastSeen: lastSeen ?? null,
    passport: { state: "unknown", resources: [], agents: [] }
  };
}

function cssBlock(styles: string, selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} should exist`);
  const end = styles.indexOf("}\n", start);
  assert.notEqual(end, -1, `${selector} should have a closing brace`);
  return styles.slice(start, end + 1);
}
