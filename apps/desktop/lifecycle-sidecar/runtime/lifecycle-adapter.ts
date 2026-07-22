import type { LifecycleSidecarDependencies } from "../handler.ts";
import type { TetiRuntime } from "./service.ts";

/**
 * Routes explicit Desktop commands and Passport reads into the single Runtime
 * owner. The unreleased fragmented read methods were removed in Task 4.
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
    getPassportSnapshot: () => runtime.getPassportSnapshot(),
    setPassportSharing: (policy) => runtime.setPassportSharing(policy)
  };
}
