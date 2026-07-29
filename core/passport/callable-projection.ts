import type { AgentComputeOffer } from "../callability/agent-core.ts";
import type { CallableAgent } from "../callability/types.ts";
import type {
  CallablePassportAgent,
  CapabilityBinding,
  ComputeOffer,
  TetiCapability
} from "./types.ts";

export interface CallablePassportProjection {
  agents: CallablePassportAgent[];
  capabilities: TetiCapability[];
  bindings: CapabilityBinding[];
  computeOffers: ComputeOffer[];
}

const AGENT_CATALOG: Readonly<Record<string, { name: string; provider: string }>> = Object.freeze({
  codex: { name: "Codex", provider: "OpenAI" },
  codebuddy: { name: "CodeBuddy Code CN", provider: "Tencent" },
  "osaurus-runtime": { name: "Osaurus Runtime (Bonsai)", provider: "Osaurus" },
  "osaurus-native-teti": { name: "Osaurus Native Agent (Teti)", provider: "Osaurus" }
});

const CAPABILITY_CATALOG: Readonly<Record<string, {
  name: string;
  category: string;
  description: string;
}>> = Object.freeze({
  "code-analysis": {
    name: "Code analysis",
    category: "coding",
    description: "Analyze code through a locally qualified AI Agent."
  },
  "image-editing": {
    name: "Image editing",
    category: "image",
    description: "Edit or generate images through a locally qualified AI Agent and return an image Artifact."
  },
  "general-text-assistance": {
    name: "General text assistance",
    category: "language",
    description: "Use receiver-local compute for tool-free general text assistance."
  }
});

/**
 * Projects only Runtime-qualified Callable Agents. Detector observations never
 * enter this function, so "installed" or "running" alone cannot become a
 * Passport claim.
 */
export function projectCallablePassport(
  callableAgents: readonly CallableAgent[],
  localComputeOffers: readonly AgentComputeOffer[] = []
): CallablePassportProjection {
  const agents = [...coalesceAgents(callableAgents).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const capabilityAgentIds = new Map<string, string[]>();
  for (const agent of agents) {
    for (const capabilityId of agent.capabilityIds) {
      const agentIds = capabilityAgentIds.get(capabilityId) ?? [];
      agentIds.push(agent.id);
      capabilityAgentIds.set(capabilityId, agentIds);
    }
  }
  const capabilities = [...capabilityAgentIds.entries()]
    .map(([capabilityId, agentIds]) => projectCapability(
      capabilityId,
      agents
        .filter((agent) => agentIds.includes(agent.id))
        .map((agent) => agent.observedAt)
        .sort()
        .at(-1)!
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  const bindings = capabilities.map((capability): CapabilityBinding => ({
    capabilityId: capability.id,
    agentIds: [...(capabilityAgentIds.get(capability.id) ?? [])].sort(),
    resourceIds: []
  }));
  const computeOffers = projectComputeOffers(agents, localComputeOffers);
  return { agents, capabilities, bindings, computeOffers };
}

function projectComputeOffers(
  agents: readonly CallablePassportAgent[],
  localComputeOffers: readonly AgentComputeOffer[]
): ComputeOffer[] {
  return localComputeOffers.flatMap((offer) => {
    const agent = agents
      .filter((candidate) =>
        candidate.capabilityIds.includes(offer.capability)
        && offer.inputModes.every((mode) => candidate.inputModes.includes(mode))
        && offer.outputModes.every((mode) => candidate.outputModes.includes(mode)))
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
    return agent ? [{ ...structuredClone(offer), observedAt: agent.observedAt }] : [];
  }).sort((left, right) => left.offerId.localeCompare(right.offerId));
}

function coalesceAgents(
  callableAgents: readonly CallableAgent[]
): Map<string, CallablePassportAgent> {
  const agents = new Map<string, CallablePassportAgent>();
  for (const callable of callableAgents) {
    const projected = projectAgent(callable);
    const existing = agents.get(projected.id);
    if (!existing) {
      agents.set(projected.id, projected);
      continue;
    }
    agents.set(projected.id, {
      ...existing,
      capabilityIds: [...new Set([
        ...existing.capabilityIds,
        ...projected.capabilityIds
      ])].sort(),
      inputModes: mergeModes(existing.inputModes, projected.inputModes),
      outputModes: mergeModes(existing.outputModes, projected.outputModes),
      observedAt: Date.parse(existing.observedAt) >= Date.parse(projected.observedAt)
        ? existing.observedAt
        : projected.observedAt
    });
  }
  return agents;
}

function mergeModes(
  left: CallablePassportAgent["inputModes"],
  right: CallablePassportAgent["inputModes"]
): CallablePassportAgent["inputModes"] {
  return [...new Set([...left, ...right])]
    .sort((first, second) => first === "text" ? -1 : second === "text" ? 1 : first.localeCompare(second));
}

function projectAgent(agent: CallableAgent): CallablePassportAgent {
  const metadata = AGENT_CATALOG[agent.agentId];
  return {
    id: agent.agentId,
    name: metadata?.name ?? humanize(agent.agentId),
    provider: metadata?.provider ?? "Unknown",
    capabilityIds: [...agent.capabilityIds].sort(),
    inputModes: [...agent.inputModes],
    outputModes: [...agent.outputModes],
    availability: "available",
    observedAt: agent.readyAt
  };
}

function projectCapability(capabilityId: string, observedAt: string): TetiCapability {
  const metadata = CAPABILITY_CATALOG[capabilityId];
  return {
    id: capabilityId,
    name: metadata?.name ?? humanize(capabilityId),
    category: metadata?.category ?? "general",
    description: metadata?.description ?? "Available through a locally qualified AI Agent.",
    availability: "available",
    observedAt
  };
}

function humanize(value: string): string {
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
