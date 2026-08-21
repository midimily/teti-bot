import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tests = [
  "apps/desktop/test/structured-task-memory.test.ts",
  "apps/desktop/test/structured-memory-recovery.test.ts",
  "apps/desktop/test/lifecycle-sidecar.test.ts",
  "apps/desktop/test/task-controller.test.ts",
  "apps/desktop/test/peer-runtime.test.ts",
  "core/memory/result-quality.test.ts"
];
const strictMemoryBenchmark = process.env.TETI_STRICT_MEMORY_BENCHMARK ?? "1";
const result = spawnSync(process.execPath, [
  "--experimental-strip-types",
  "--test",
  ...tests
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    TETI_STRICT_MEMORY_BENCHMARK: strictMemoryBenchmark
  },
  stdio: "inherit"
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
