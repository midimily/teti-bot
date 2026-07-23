import { homedir } from "node:os";
import {
  assertAlphaLocalResetConfirmed,
  resetLocalTeti,
  resetTetiOnboarding
} from "./local-reset.ts";

const args = parseArgs(process.argv.slice(2));
const alphaLocalReset = Boolean(args["alpha-local-reset"]);
const onboardingRegression = Boolean(args["onboarding-regression"]);

try {
  if (onboardingRegression) {
    const result = await resetTetiOnboarding({
      home: homedir(),
      confirmation: stringArg(args, "confirm"),
      registryConfirmation: stringArg(args, "registry-confirm"),
      deleteRegistry: Boolean(args["delete-registry"]),
      dryRun: Boolean(args["dry-run"])
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (alphaLocalReset) {
      assertAlphaLocalResetConfirmed(stringArg(args, "confirm"));
    }
    const result = await resetLocalTeti({
      home: homedir(),
      dryRun: Boolean(args["dry-run"]),
      extraProfile: stringArg(args, "profile"),
      allowOrphanRealAccount: alphaLocalReset || Boolean(args["allow-orphan-real-account"])
    });
    console.log(JSON.stringify({
      ...result,
      mode: alphaLocalReset ? "alpha_force_local_reset" : "first_launch_reset"
    }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function stringArg(values: Record<string, string | boolean>, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}
