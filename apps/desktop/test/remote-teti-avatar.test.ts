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

test("Network Presence alone controls online, checking, offline, and unavailable presentation", () => {
  const base = confirmedPeer(new Date(now - 1_000).toISOString());
  const online = {
    ...base,
    networkPresence: {
      state: "online" as const,
      mode: "online" as const,
      reportedAt: new Date(now - 1_000).toISOString(),
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 45_000).toISOString()
    }
  };
  const checking = { ...base, networkPresence: { state: "checking" as const } };
  const offline = {
    ...base,
    networkPresence: { state: "offline" as const, observedAt: new Date(now).toISOString() }
  };
  const unavailable = {
    ...base,
    networkPresence: {
      state: "unavailable" as const,
      checkedAt: new Date(now).toISOString(),
      errorCode: "NETWORK_TIMEOUT"
    }
  };

  assert.deepEqual(
    [online, checking, offline, unavailable].map((peer) => {
      const card = toConnectionCardViewModel(peer, new Date(now));
      return [card.reachability, card.reachabilityLabel];
    }),
    [
      ["reachable", "在线"],
      ["checking", "状态检测中"],
      ["unreachable", "离线"],
      ["unavailable", "状态暂不可用"]
    ]
  );
});

test("remote avatar reserves blue for online and uses gray with a static yellow checking dot", async () => {
  const [component, app, styles, asset] = await Promise.all([
    readFile(new URL("../src/connections/remote-teti-avatar.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/remote-teti-silhouette.png", import.meta.url))
  ]);
  const avatarStyles = cssBlock(styles, ".teti-remote-avatar");
  const silhouetteStyles = cssBlock(styles, ".teti-remote-avatar-silhouette");
  const reachableStyles = cssBlock(styles, ".teti-remote-avatar.is-reachable");
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
  assert.match(reachableStyles, /var\(--teti-remote-reachable\)/);
  assert.match(checkingStyles, /var\(--teti-remote-unreachable\)/);
  assert.match(styles, /\.teti-remote-avatar\.is-unavailable\s*\{[\s\S]*?var\(--teti-remote-unreachable\)/);
  assert.match(indicatorStyles, /position:\s*absolute/);
  assert.match(indicatorStyles, /background:\s*var\(--teti-remote-checking\)/);
  assert.doesNotMatch(indicatorStyles, /animation/);
  assert.match(styles, /--teti-remote-reachable:\s*var\(--teti-blue-primary\)/);
  assert.match(styles, /--teti-remote-unreachable:\s*#aebdca/);
  assert.doesNotMatch(app, /createElement\(Radio/);
});

test("confirmed peers use a stable identity-first semantic list summary", async () => {
  const [app, passportView, styles] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/passport/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(app, /main\.append\(createRemoteTetiAvatar\(\{/);
  assert.match(app, /label:\s*connection\.reachabilityLabel/);
  assert.match(app, /name\.textContent = connection\.displayName/);
  assert.match(app, /publicId\.textContent = connection\.publicIdCode/);
  assert.match(app, /document\.createElement\("ul"\)/);
  assert.match(app, /document\.createElement\("li"\)/);
  assert.match(app, /teti-connection-disclosure/);
  assert.doesNotMatch(app, /row\.addEventListener\("click"/);
  assert.doesNotMatch(app, /•••/);
  assert.doesNotMatch(app, /connection\.address/);
  assert.doesNotMatch(app, /teti-connection-presence|teti-connection-relationship|teti-connection-reachability/);
  assert.match(app, /state\.append\(createRemotePassport\(connection\.passport, i18n\)\)/);
  assert.match(passportView, /viewModel\.summary\.resource/);
  assert.match(passportView, /viewModel\.summary\.agents/);
  assert.match(passportView, /viewModel\.summary\.capabilities/);
  assert.match(passportView, /name\.textContent = agent\.name/);
  assert.match(passportView, /teti-peer-signal-summary/);
  assert.match(passportView, /createSummaryOverflow/);
  assert.match(app, /connection\.compatibility === "compatible"/);
  assert.match(app, /messages\.connections\.list\.compatibility\.upgradeHint/);
  assert.match(app, /messages\.connections\.list\.compatibility\.checkingHint/);
  assert.match(app, /setAttribute\("role", "alertdialog"\)/);
  assert.match(app, /messages\.updateBlocker\.message/);
  assert.doesNotMatch(app, /已建联设备需要升级或完成版本检测/);
  assert.doesNotMatch(app, /teti-protocol-blocker-button/);
  assert.match(app, /const brand = createTetiBotBrandLink\(\{/);
  assert.match(app, /messages\.brand\.websiteLabel/);
  assert.doesNotMatch(app, /teti-brand-dot/);
  assert.match(
    styles,
    /Beta 0\.2\.1 connection-list integration:[\s\S]*\.teti-connection-row\.is-confirmed \.teti-connection-row-main\s*\{[\s\S]*height:\s*64px;[\s\S]*grid-template-columns:\s*28px minmax\(76px, 96px\) minmax\(0, 1fr\) 28px;/
  );
  assert.match(styles, /Beta 0\.2\.1 connection-list integration:[\s\S]*\.teti-peer-ai-status\s*\{[\s\S]*grid-template-rows:\s*repeat\(2, 17px\);/);
  assert.match(styles, /\.teti-island--connections\.has-peer-details \.teti-connection-list\s*\{[\s\S]*max-height:/);
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
  const openingBrace = styles.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return styles.slice(start, index + 1);
  }
  assert.fail(`${selector} should have a closing brace`);
}
