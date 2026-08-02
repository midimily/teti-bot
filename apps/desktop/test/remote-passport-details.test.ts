import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("remote Passport details use one native disclosure inside a semantic list row", async () => {
  const [app, controller] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/connections/controller.ts", import.meta.url), "utf8")
  ]);

  assert.match(app, /const list = document\.createElement\("ul"\)/);
  assert.match(app, /const row = document\.createElement\("li"\)/);
  assert.match(app, /disclosure\.classList\.add\("teti-connection-disclosure"\)/);
  assert.match(app, /disclosure\.setAttribute\("aria-controls", connectionDetailsId\(connection\.requestId\)\)/);
  assert.match(app, /disclosure\.setAttribute\("aria-expanded", String\(expanded\)\)/);
  assert.doesNotMatch(app, /row\.addEventListener\("click"/);
  assert.doesNotMatch(app, /•••/);
  assert.match(app, /focusKeyWithin\(root\)/);
  assert.match(app, /restoreFocusKey\(root, focusKey\)/);
  assert.match(app, /details\.inert = !isExpanded/);
  assert.match(controller, /if \(this\.snapshotValue\.expandedRequestId\) \{[\s\S]*this\.closeDetails\(\);[\s\S]*return true;/);
  assert.match(controller, /setMode\("connection_detail", "peer-details-open"\)/);
  assert.match(controller, /CONNECTION_DETAILS_TRANSITION_MS/);
});

test("remote Passport details partition complete data and expose truthful accessible status", async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL("../src/passport/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  for (const section of ["Resource", "Agent", "Provider", "Capability"]) {
    assert.match(view, new RegExp(`createRemoteDetailSection\\(\\s*"${section}"`));
  }
  assert.match(view, /resource\.quotas\.length/);
  assert.match(view, /agent\.versionLabel/);
  assert.match(view, /capability\.bindings\.length/);
  assert.match(view, /binding\.statusLabel/);
  assert.match(view, /track\.setAttribute\("role", "progressbar"\)/);
  assert.match(view, /track\.setAttribute\("aria-valuenow"/);
  assert.match(view, /image\.addEventListener\("error"[\s\S]*fallback\.hidden = false/);
  assert.match(view, /mark\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(styles, /\.teti-peer-details\s*\{[\s\S]*grid-template-rows:\s*0fr/);
  assert.match(styles, /\.teti-peer-details\.is-expanded\s*\{[\s\S]*grid-template-rows:\s*1fr/);
  assert.match(styles, /\.teti-connection-disclosure:focus-visible/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("native connection detail mode follows measured content within screen bounds", async () => {
  const [app, typescriptMode, rustWindow, macPanel] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/platform/tauri-notch-window.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/window.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/macos_panel.rs", import.meta.url), "utf8")
  ]);

  assert.match(typescriptMode, /\| "connection_detail"/);
  assert.match(typescriptMode, /setConnectionDetailHeight\(height: number, reason: string\)/);
  assert.match(app, /resolveConnectionDetailLayout/);
  assert.match(app, /sections\.scrollHeight - sections\.clientHeight/);
  assert.match(app, /event\.propertyName === "grid-template-rows"/);
  assert.match(app, /CONNECTION_DETAILS_TRANSITION_MS \+ 60/);
  assert.match(app, /resized\.then\(\(\) =>/);
  assert.match(rustWindow, /CONNECTION_DETAIL_BASE_HEIGHT: f64 = 352\.0/);
  assert.match(rustWindow, /MAX_ISLAND_HEIGHT: f64 = 1_200\.0/);
  assert.match(rustWindow, /set_connection_detail_height/);
  assert.match(macPanel, /resize_connection_detail/);
  assert.match(macPanel, /connection_detail_height\(requested, info\.height as f64\)/);
});

test("Passport and header panels share one low-contrast local scrollbar treatment", async () => {
  const [styles, view] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/passport/view.ts", import.meta.url), "utf8")
  ]);

  assert.match(styles, /--teti-scrollbar-thumb:\s*rgba\(45, 103, 151, 0\.14\)/);
  assert.match(styles, /\.teti-island--connections\.has-peer-details \.teti-connection-list\s*\{[\s\S]*overflow:\s*visible/);
  assert.match(styles, /max-height:\s*var\(--teti-peer-details-max-height, 320px\)/);
  assert.match(styles, /--teti-header-panel-viewport-offset:\s*calc\(74px \+ var\(--teti-safe-top-inset\)\)/);
  assert.match(styles, /max-height:\s*min\(430px, calc\(100vh - var\(--teti-header-panel-viewport-offset\)\)\)/);
  assert.match(styles, /max-height:\s*min\(380px, calc\(100vh - var\(--teti-header-panel-viewport-offset\)\)\)/);
  assert.doesNotMatch(styles, /max-height:\s*min\((?:430|380)px, calc\(100vh - 24px\)\)/);
  assert.match(view, /if \(viewModel\.showOsaurusNativeConfiguration\) \{[\s\S]*createOsaurusNativeChildSection/);
  assert.match(
    styles,
    /\.teti-connection-list,[\s\S]*\.teti-ai-status-panel,[\s\S]*\.teti-sharing-panel,[\s\S]*\.teti-peer-details-sections\s*\{[\s\S]*scrollbar-color:\s*var\(--teti-scrollbar-thumb\) transparent/
  );
});
