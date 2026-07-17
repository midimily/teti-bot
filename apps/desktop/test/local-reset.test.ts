import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALPHA_LOCAL_RESET_CONFIRMATION,
  assertAlphaLocalResetConfirmed,
  defaultLocalResetTargets,
  resetLocalTeti
} from "../scripts/local-reset.ts";

test("Alpha local reset requires an exact destructive confirmation", () => {
  assert.throws(() => assertAlphaLocalResetConfirmed(undefined), /DELETE_LOCAL_TETI/);
  assert.throws(() => assertAlphaLocalResetConfirmed("delete-local-teti"), /DELETE_LOCAL_TETI/);
  assert.doesNotThrow(() => assertAlphaLocalResetConfirmed(ALPHA_LOCAL_RESET_CONFIRMATION));
});

test("Alpha local reset removes first-install state locally without remote deletion", async () => {
  const home = await mkdtemp(join(tmpdir(), "teti-alpha-local-reset-"));
  try {
    const targets = defaultLocalResetTargets(home);
    await mkdir(join(home, ".teti", "account"), { recursive: true });
    await writeFile(
      join(home, ".teti", "account", "account.json"),
      JSON.stringify({ address: "alpha-reset@mail.seep.im" }),
      "utf8"
    );
    await mkdir(targets[1], { recursive: true });
    await writeFile(join(targets[1], "webview-state"), "test", "utf8");

    await assert.rejects(() => resetLocalTeti({ home, dryRun: true }), /Refusing to remove/);

    const result = await resetLocalTeti({
      home,
      allowOrphanRealAccount: true
    });

    assert.equal(result.localOnly, true);
    assert.equal(result.remoteChatmailDeleted, false);
    assert.equal(result.remoteDiscoveryDeleted, false);
    assert.equal(result.results.find((item) => item.path === join(home, ".teti"))?.removed, true);
    await assert.rejects(() => stat(join(home, ".teti")), /ENOENT/);
    await assert.rejects(() => stat(targets[1]), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("connection input uses a dimmed nine-star example instead of a real ID", async () => {
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /input\.placeholder = "\*{9}"/);
  assert.match(styles, /\.teti-connect-input::placeholder[\s\S]*opacity: 0\.48/);
});
