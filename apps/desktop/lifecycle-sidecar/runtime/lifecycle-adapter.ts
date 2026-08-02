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
    getTetiStatus: () => runtime.getTetiStatus(),
    registerDiscovery: async (account) => {
      await base.registerDiscovery(account);
      runtime.notifyRegistryRegistered(account);
    },
    heartbeatDiscovery: () => runtime.readDiscoveryAccount(),
    getLocalReleaseStatus: () => runtime.getLocalReleaseStatus(),
    getPeerConnectionService: async () => runtime.getPeerConnectionFacade(),
    getPassportSnapshot: () => runtime.getPassportSnapshot(),
    setPassportSharing: (policy) => runtime.setPassportSharing(policy),
    getAgentManagementSnapshot: () => runtime.getAgentManagementSnapshot(),
    rescanAgents: () => runtime.rescanAgents(),
    setAgentPathOverride: (agentId, path) => runtime.setAgentPathOverride(agentId, path),
    getChildMemory: () => runtime.getChildMemory(),
    setChildMemoryAuthorization: (input) => runtime.setChildMemoryAuthorization(input),
    saveTaskMemory: (taskId, scope, confirmed) => runtime.saveTaskMemory(taskId, scope, confirmed),
    deleteChildMemory: (memoryId) => runtime.deleteChildMemory(memoryId),
    exportChildMemory: () => runtime.exportChildMemory()
  };
}
