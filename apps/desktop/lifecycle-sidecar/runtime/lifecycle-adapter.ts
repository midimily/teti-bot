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
      try {
        const synchronized = await runtime.synchronizeNetworkIdentity();
        try {
          await base.onNetworkIdentitySynchronized?.(synchronized);
        } catch {
          // Marker/manifest metadata cannot roll back a committed Network identity.
        }
        runtime.notifyAccountAvailable(synchronized, { synchronizeNetworkIdentity: false });
        return synchronized;
      } catch {
        // Local/Chatmail identity remains usable; the Runtime job owns recovery and diagnostics.
        const recovered = await base.loadTetiAccount().catch(() => null) ?? account;
        runtime.notifyAccountAvailable(recovered);
        return recovered;
      }
    },
    getTetiStatus: () => runtime.getTetiStatus(),
    synchronizeNetworkIdentity: async () => {
      const synchronized = await runtime.synchronizeNetworkIdentity();
      try {
        await base.onNetworkIdentitySynchronized?.(synchronized);
      } catch {
        // Marker/manifest metadata cannot roll back a committed Network identity.
      }
      runtime.notifyNetworkIdentityActive(synchronized);
      return synchronized;
    },
    getPresenceStatus: () => runtime.getPresenceSnapshot(),
    setPresenceSignal: ({ signal, active }) => {
      if (signal === "sleeping") runtime.setPresenceSleeping(active);
      if (signal === "foreground") runtime.setPresenceForeground(active);
      if (signal === "panel_visible") runtime.setPresencePanelVisible(active);
    },
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
