import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Renderer consumes Passport ViewModels and has no legacy AI data dependency", async () => {
  const [app, view, controller] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/passport/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/passport/controller.ts", import.meta.url), "utf8")
  ]);
  const renderer = `${app}\n${view}`;

  assert.doesNotMatch(renderer, /RemoteAiStatusSnapshot|CodexUsageState|statusSharing|Registry|Chatmail/);
  assert.doesNotMatch(renderer, /openai\.codex/);
  assert.doesNotMatch(controller, /connection\.poll|usage\.(get|refresh)|sharing\.get/);
  assert.match(controller, /passport\.get/);
});

test("Runtime Passport service is an aggregator and imports no network adapter", async () => {
  const service = await readFile(
    new URL("../lifecycle-sidecar/runtime/passport/service.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(service, /RegistryDiscoveryClient|Chatmail|fetch\(|refreshNow\(|\.poll\(/);
  assert.match(service, /getConnections\(\)/);
  assert.match(service, /getCodexUsage\(\)/);
});

test("private IPC exposes one Passport read surface and no fragmented status reads", async () => {
  const protocol = await readFile(new URL("../src/lifecycle-bridge/protocol.ts", import.meta.url), "utf8");

  assert.match(protocol, /"passport\.get"/);
  assert.match(protocol, /"passport\.sharing\.set"/);
  assert.doesNotMatch(protocol, /"connection\.poll"|"connection\.list"|"usage\.get"|"usage\.refresh"|"sharing\.get"/);
});
