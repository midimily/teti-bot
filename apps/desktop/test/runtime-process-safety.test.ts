import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireTetiRuntimeProfileLock,
  TetiRuntimeAlreadyActiveError
} from "../lifecycle-sidecar/runtime/profile-lock.ts";
import {
  SafeProcessWriter,
  type ProcessWritable
} from "../lifecycle-sidecar/runtime/safe-output.ts";

test("safe process output fails closed after EPIPE without recursive writes", () => {
  const stream = new FakeWritable();
  let failures = 0;
  const writer = new SafeProcessWriter(stream, () => {
    failures += 1;
    throw new Error("diagnostic callback failure");
  });

  assert.equal(writer.write("first\n"), true);
  stream.emitError(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  assert.equal(writer.write("must not be written\n"), false);
  stream.emitError(Object.assign(new Error("again"), { code: "EPIPE" }));
  assert.equal(writer.isWritable, false);
  assert.equal(failures, 1);
  assert.deepEqual(stream.writes, ["first\n"]);
});

test("safe process output catches synchronous write failures once", () => {
  const stream = new FakeWritable();
  stream.throwOnWrite = true;
  let failures = 0;
  const writer = new SafeProcessWriter(stream, () => { failures += 1; });

  assert.equal(writer.write("response\n"), false);
  assert.equal(writer.write("second response\n"), false);
  assert.equal(failures, 1);
});

test("profile lock rejects a second live Runtime and releases only its own token", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-runtime-lock-live-"));
  const lifecycleDir = join(root, "lifecycle");
  await mkdir(lifecycleDir, { recursive: true });
  try {
    const first = await acquireTetiRuntimeProfileLock(
      { lifecycleDir },
      { pid: 101, token: "owner-one", isProcessAlive: (pid) => pid === 101 }
    );
    await assert.rejects(
      acquireTetiRuntimeProfileLock(
        { lifecycleDir },
        { pid: 202, token: "owner-two", isProcessAlive: (pid) => pid === 101 }
      ),
      TetiRuntimeAlreadyActiveError
    );
    assert.match(await readFile(first.path, "utf8"), /owner-one/);
    await first.release();

    const second = await acquireTetiRuntimeProfileLock(
      { lifecycleDir },
      { pid: 202, token: "owner-two", isProcessAlive: () => false }
    );
    assert.match(await readFile(second.path, "utf8"), /owner-two/);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile lock atomically replaces a stale owner without allowing the old owner to remove the new lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-runtime-lock-stale-"));
  const lifecycleDir = join(root, "lifecycle");
  await mkdir(lifecycleDir, { recursive: true });
  try {
    const stale = await acquireTetiRuntimeProfileLock(
      { lifecycleDir },
      { pid: 303, token: "stale-owner", isProcessAlive: () => false }
    );
    const current = await acquireTetiRuntimeProfileLock(
      { lifecycleDir },
      { pid: 404, token: "current-owner", isProcessAlive: () => false }
    );

    await stale.release();
    assert.match(await readFile(current.path, "utf8"), /current-owner/);
    await current.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeWritable implements ProcessWritable {
  readonly writes: string[] = [];
  private readonly errorListeners: Array<(error: Error & { code?: string }) => void> = [];
  throwOnWrite = false;

  write(chunk: string): unknown {
    if (this.throwOnWrite) throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    this.writes.push(chunk);
    return true;
  }

  on(_event: "error", listener: (error: Error & { code?: string }) => void): unknown {
    this.errorListeners.push(listener);
    return this;
  }

  emitError(error: Error & { code?: string }): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
