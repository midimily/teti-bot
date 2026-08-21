import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StructuredMemoryAgentQualityObservation } from "../../../core/memory/result-quality.ts";
import { evaluateStructuredMemoryAgentQuality } from "../../../core/memory/result-quality.ts";
import {
  restoreStructuredTaskMemoryBackup,
  SqliteStructuredTaskMemoryStore
} from "../lifecycle-sidecar/runtime/memory/structured-task-sqlite.ts";

const [command, ...arguments_] = process.argv.slice(2);
const options = parseOptions(arguments_);

switch (command) {
  case "health": {
    const store = new SqliteStructuredTaskMemoryStore({ path: requiredPath(options, "database") });
    try {
      console.log(JSON.stringify(await store.getHealth(), null, 2));
    } finally {
      await store.close();
    }
    break;
  }
  case "export": {
    requireConfirmation(options);
    const store = new SqliteStructuredTaskMemoryStore({ path: requiredPath(options, "database") });
    try {
      console.log(JSON.stringify(await store.exportBackup(requiredPath(options, "output"), {
        confirmed: true,
        createdAt: new Date().toISOString()
      }), null, 2));
    } finally {
      await store.close();
    }
    break;
  }
  case "restore": {
    requireConfirmation(options);
    console.log(JSON.stringify(await restoreStructuredTaskMemoryBackup({
      databasePath: requiredPath(options, "database"),
      backupPath: requiredPath(options, "backup"),
      confirmed: true,
      restoredAt: new Date().toISOString()
    }), null, 2));
    break;
  }
  case "maintenance": {
    requireConfirmation(options);
    const store = new SqliteStructuredTaskMemoryStore({ path: requiredPath(options, "database") });
    try {
      console.log(JSON.stringify(await store.runMaintenance({
        schemaVersion: 1,
        confirmed: true,
        executedAt: new Date().toISOString()
      }), null, 2));
    } finally {
      await store.close();
    }
    break;
  }
  case "quality": {
    const observation = JSON.parse(
      await readFile(requiredPath(options, "input"), "utf8")
    ) as StructuredMemoryAgentQualityObservation;
    console.log(JSON.stringify(evaluateStructuredMemoryAgentQuality(observation), null, 2));
    break;
  }
  default:
    throw new Error(
      "Usage: memory-recovery-cli health --database <path> | "
      + "export --database <path> --output <path> --confirm | "
      + "restore --database <path> --backup <path> --confirm | "
      + "maintenance --database <path> --confirm | quality --input <path>"
    );
}

function parseOptions(values: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!value.startsWith("--")) throw new Error("Recovery option is invalid.");
    const name = value.slice(2);
    if (name === "confirm") {
      result.set(name, true);
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Recovery option --${name} requires a value.`);
    result.set(name, next);
    index += 1;
  }
  return result;
}

function requiredPath(options: ReadonlyMap<string, string | true>, name: string): string {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Recovery option --${name} is required.`);
  return resolve(value);
}

function requireConfirmation(options: ReadonlyMap<string, string | true>): void {
  if (options.get("confirm") !== true) {
    throw new Error("Recovery mutation requires explicit --confirm.");
  }
}
