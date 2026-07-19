import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  openTetiBotWebsite,
  TETI_BOT_BRAND,
  TETI_BOT_URL
} from "../src/brand/teti-bot-website.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const desktopRoot = join(repoRoot, "apps", "desktop");

test("Teti.bot website action always uses the fixed production URL", async () => {
  const calls: string[] = [];

  const opened = await openTetiBotWebsite(async (url) => {
    calls.push(url);
  });

  assert.equal(TETI_BOT_BRAND, "Teti.bot");
  assert.equal(TETI_BOT_URL, "https://teti.bot/");
  assert.equal(opened, true);
  assert.deepEqual(calls, ["https://teti.bot/"]);
});

test("Teti.bot website action reports opener failures without rejecting", async () => {
  const diagnostics: unknown[] = [];
  const failure = new Error("simulated opener failure");

  const opened = await openTetiBotWebsite(
    async () => { throw failure; },
    { warn: (...args: unknown[]) => diagnostics.push(args) }
  );

  assert.equal(opened, false);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], [
    "Teti.bot website could not be opened in the system browser.",
    { url: "https://teti.bot/", error: failure }
  ]);
});

test("desktop brand uses a fixed accessible SVG wordmark with only the i dot accented", () => {
  const app = readFileSync(join(desktopRoot, "src", "app.ts"), "utf8");
  const component = readFileSync(
    join(desktopRoot, "src", "brand", "teti-bot-brand-link.ts"),
    "utf8"
  );
  const styles = readFileSync(join(desktopRoot, "src", "styles.css"), "utf8");
  const wordmark = readFileSync(
    join(desktopRoot, "assets", "branding", "teti-bot-wordmark.svg"),
    "utf8"
  );

  assert.match(app, /createTetiBotBrandLink/);
  assert.doesNotMatch(app, /teti-brand-dot/);
  assert.doesNotMatch(styles, /teti-brand-dot/);
  assert.match(component, /button\.type = "button"/);
  assert.match(component, /button\.lang = "en"/);
  assert.match(component, /button\.dir = "ltr"/);
  assert.match(component, /setAttribute\("translate", "no"\)/);
  assert.match(component, /setAttribute\("aria-label", `访问 \$\{TETI_BOT_BRAND\} 官网`\)/);
  assert.match(component, /wordmark\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(component, /fixedBrandText\.textContent = TETI_BOT_BRAND/);
  assert.match(component, /TETI_BOT_OPENING_EVENT/);
  assert.match(component, /TETI_BOT_OPEN_SETTLED_EVENT/);
  assert.match(app, /if \(preserveStateForBrandOpen\) \{[\s\S]*clearBrandOpenGuard\(\);[\s\S]*return;/);
  assert.match(wordmark, /viewBox="0 0 7585 1579"/);
  assert.match(wordmark, /class="teti-brand-wordmark-body" fill="var\(--teti-brand-foreground\)"/);
  assert.match(wordmark, /class="teti-brand-wordmark-accent" fill="var\(--teti-brand-accent\)"/);
  assert.equal((wordmark.match(/<path /g) ?? []).length, 2);
  assert.match(styles, /--teti-brand-foreground:\s*var\(--teti-text-primary\)/);
  assert.match(styles, /--teti-brand-accent:\s*#0067ff/);
  assert.match(styles, /\.teti-brand\s*\{[\s\S]*text-decoration:\s*none/);
  assert.doesNotMatch(styles.match(/\.teti-brand:hover\s*\{[^}]*\}/)?.[0] ?? "", /transform|scale|underline/);
});

test("Tauri opener capability only permits the fixed Teti.bot URL", () => {
  const capability = JSON.parse(readFileSync(
    join(desktopRoot, "src-tauri", "capabilities", "default.json"),
    "utf8"
  )) as { permissions: Array<string | { identifier: string; allow: Array<{ url: string }> }> };
  const openerPermission = capability.permissions.find(
    (permission) => typeof permission !== "string" && permission.identifier === "opener:allow-open-url"
  );

  assert.deepEqual(openerPermission, {
    identifier: "opener:allow-open-url",
    allow: [{ url: "https://teti.bot/" }]
  });
});
