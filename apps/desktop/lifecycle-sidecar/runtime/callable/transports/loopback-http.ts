import type {
  ExecutionHandle,
  ExecutionSpec,
  ExecutionTransport
} from "../../../../../../core/callability/agent-core.ts";

/**
 * 0.2.1 reserves the transport boundary but intentionally performs no HTTP.
 * It can only become active in a later version after a separate threat review.
 */
export class LoopbackHttpTransport implements ExecutionTransport {
  readonly kind = "loopback_http" as const;

  start(_input: { spec: ExecutionSpec; workspacePath: string }): ExecutionHandle {
    throw new Error("LoopbackHttpTransport is reserved and disabled in Teti 0.2.1.");
  }
}
