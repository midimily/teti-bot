import type { LifecycleSidecarDependencies } from "../handler.ts";
import type { TetiRuntime } from "./service.ts";

/**
 * Keeps the v1 Desktop IPC surface compatible while Runtime is the only owner
 * of periodic network work. Task 3 may later remove the obsolete UI timers,
 * but it does not need to change this private IPC contract.
 */
export function createRuntimeOwnedLifecycleDependencies(
  base: LifecycleSidecarDependencies,
  runtime: TetiRuntime
): LifecycleSidecarDependencies {
  return {
    ...base,
    createTetiAccount: async (input) => {
      const account = await base.createTetiAccount(input);
      runtime.notifyAccountAvailable(account);
      return account;
    },
    registerDiscovery: async (account) => {
      await base.registerDiscovery(account);
      runtime.notifyAccountAvailable(account);
    },
    heartbeatDiscovery: () => runtime.readDiscoveryAccount(),
    getPeerConnectionService: async () => runtime.getPeerConnectionFacade(),
    getCodexUsageState: () => runtime.getCodexUsageState(),
    refreshCodexUsage: () => runtime.waitForCodexUsageState()
  };
}
