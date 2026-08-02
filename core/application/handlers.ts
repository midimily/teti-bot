import type {
  TetiApplicationEnvelope,
  TetiCapabilityOfferPayload,
  TetiPresencePayload,
  TetiProfileSyncPayload
} from "../protocol/types.ts";
import type { AiStatusSyncPayload } from "../ai-status/types.ts";
import type { CollaborationTaskRequest } from "../task/types.ts";
import type {
  TetiTaskArtifactPayload,
  TetiTaskAttachmentPayload,
  TetiTaskAttachmentReceiptPayload,
  TetiTaskCancelPayload,
  TetiTaskInputPayload,
  TetiTaskReceiptPayload,
  TetiTaskStatusPayload
} from "../task/transport.ts";

export type TetiApplicationHandlerResult =
  | {
      type: "profile.sync";
      messageId: string;
      fromTetiId: string;
      profile: TetiProfileSyncPayload;
    }
  | {
      type: "capability.offer";
      messageId: string;
      fromTetiId: string;
      capabilities: string[];
    }
  | {
      type: "presence";
      messageId: string;
      fromTetiId: string;
      presence: TetiPresencePayload;
    }
  | {
      type: "ai.status.sync";
      messageId: string;
      fromTetiId: string;
      status: AiStatusSyncPayload;
    }
  | {
      type: "task.request";
      messageId: string;
      fromTetiId: string;
      request: CollaborationTaskRequest;
    }
  | {
      type: "task.receipt";
      messageId: string;
      fromTetiId: string;
      receipt: TetiTaskReceiptPayload;
    }
  | {
      type: "task.attachment";
      messageId: string;
      fromTetiId: string;
      attachment: TetiTaskAttachmentPayload;
    }
  | {
      type: "task.attachment.receipt";
      messageId: string;
      fromTetiId: string;
      receipt: TetiTaskAttachmentReceiptPayload;
    }
  | {
      type: "task.status";
      messageId: string;
      fromTetiId: string;
      status: TetiTaskStatusPayload;
    }
  | {
      type: "task.cancel";
      messageId: string;
      fromTetiId: string;
      cancel: TetiTaskCancelPayload;
    }
  | {
      type: "task.input";
      messageId: string;
      fromTetiId: string;
      input: TetiTaskInputPayload;
    }
  | {
      type: "task.artifact";
      messageId: string;
      fromTetiId: string;
      artifact: TetiTaskArtifactPayload;
    };

export function handleApplicationEnvelope(
  envelope: TetiApplicationEnvelope
): TetiApplicationHandlerResult {
  if (envelope.type === "teti.profile.sync") {
    return {
      type: "profile.sync",
      messageId: envelope.messageId,
      fromTetiId: envelope.fromTetiId,
      profile: envelope.payload as TetiProfileSyncPayload
    };
  }

  if (envelope.type === "teti.capability.offer") {
    return {
      type: "capability.offer",
      messageId: envelope.messageId,
      fromTetiId: envelope.fromTetiId,
      capabilities: (envelope.payload as TetiCapabilityOfferPayload).capabilities
    };
  }

  if (envelope.type === "teti.presence") return {
    type: "presence",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    presence: envelope.payload as TetiPresencePayload
  };

  if (envelope.type === "teti.ai.status.sync") return {
    type: "ai.status.sync",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    status: envelope.payload as AiStatusSyncPayload
  };

  if (envelope.type === "teti.task.request") return {
    type: "task.request",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    request: envelope.payload as CollaborationTaskRequest
  };

  if (envelope.type === "teti.task.receipt") return {
    type: "task.receipt",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    receipt: envelope.payload as TetiTaskReceiptPayload
  };

  if (envelope.type === "teti.task.attachment") return {
    type: "task.attachment",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    attachment: envelope.payload as TetiTaskAttachmentPayload
  };

  if (envelope.type === "teti.task.attachment.receipt") return {
    type: "task.attachment.receipt",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    receipt: envelope.payload as TetiTaskAttachmentReceiptPayload
  };

  if (envelope.type === "teti.task.status") return {
    type: "task.status",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    status: envelope.payload as TetiTaskStatusPayload
  };

  if (envelope.type === "teti.task.cancel") return {
    type: "task.cancel",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    cancel: envelope.payload as TetiTaskCancelPayload
  };

  if (envelope.type === "teti.task.input") return {
    type: "task.input",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    input: envelope.payload as TetiTaskInputPayload
  };

  return {
    type: "task.artifact",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    artifact: envelope.payload as TetiTaskArtifactPayload
  };
}
