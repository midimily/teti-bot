import type {
  TetiApplicationEnvelope,
  TetiCapabilityOfferPayload,
  TetiPresencePayload,
  TetiProfileSyncPayload
} from "../protocol/types.ts";

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

  return {
    type: "presence",
    messageId: envelope.messageId,
    fromTetiId: envelope.fromTetiId,
    presence: envelope.payload as TetiPresencePayload
  };
}
