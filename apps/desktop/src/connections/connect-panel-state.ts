export type ConnectPanelState =
  | "idle"
  | "opening"
  | "editing"
  | "connecting"
  | "success"
  | "error"
  | "closing";

export type ConnectPanelMessageTone = "hint" | "progress" | "success" | "error";

export type ConnectPanelMessageCode =
  | "connecting"
  | "invalid_public_id"
  | "request_sent"
  | "approval_required"
  | "connected"
  | "already_connected"
  | "connection_timeout"
  | "identity_not_found"
  | "connection_failed";

export interface ConnectPanelSnapshot {
  state: ConnectPanelState;
  messageCode?: ConnectPanelMessageCode;
  messageTone: ConnectPanelMessageTone;
}

export type ConnectPanelEvent =
  | { type: "EYES_CLICKED" }
  | { type: "OPEN_ANIMATION_FINISHED" }
  | { type: "INPUT_CHANGED" }
  | { type: "VALIDATION_FAILED"; messageCode: ConnectPanelMessageCode }
  | { type: "SUBMIT" }
  | { type: "CONNECT_SUCCEEDED"; messageCode: ConnectPanelMessageCode }
  | { type: "CONNECT_FAILED"; messageCode: ConnectPanelMessageCode }
  | { type: "ESCAPE_PRESSED" }
  | { type: "CLOSE_REQUESTED" }
  | { type: "CLOSE_ANIMATION_FINISHED" }
  | { type: "SUCCESS_TIMEOUT" }
  | { type: "RESET" };

export function initialConnectPanelSnapshot(): ConnectPanelSnapshot {
  return {
    state: "idle",
    messageTone: "hint"
  };
}

export function transitionConnectPanel(
  snapshot: ConnectPanelSnapshot,
  event: ConnectPanelEvent
): ConnectPanelSnapshot {
  if (event.type === "RESET") return initialConnectPanelSnapshot();

  switch (snapshot.state) {
    case "idle":
      return event.type === "EYES_CLICKED"
        ? panel("opening", undefined, "hint")
        : snapshot;
    case "opening":
      return event.type === "OPEN_ANIMATION_FINISHED"
        ? panel("editing", undefined, "hint")
        : snapshot;
    case "editing":
      if (event.type === "INPUT_CHANGED") return panel("editing", undefined, "hint");
      if (event.type === "VALIDATION_FAILED") return panel("error", event.messageCode, "error");
      if (event.type === "SUBMIT") return panel("connecting", "connecting", "progress");
      if (isCloseEvent(event)) return panel("closing", undefined, "hint");
      return snapshot;
    case "connecting":
      if (event.type === "CONNECT_SUCCEEDED") return panel("success", event.messageCode, "success");
      if (event.type === "CONNECT_FAILED") return panel("error", event.messageCode, "error");
      return snapshot;
    case "success":
      if (event.type === "SUCCESS_TIMEOUT" || isCloseEvent(event)) {
        return panel("closing", undefined, "hint");
      }
      return snapshot;
    case "error":
      if (event.type === "INPUT_CHANGED") return panel("editing", undefined, "hint");
      if (event.type === "VALIDATION_FAILED") return panel("error", event.messageCode, "error");
      if (event.type === "SUBMIT") return panel("connecting", "connecting", "progress");
      if (isCloseEvent(event)) return panel("closing", undefined, "hint");
      return snapshot;
    case "closing":
      return event.type === "CLOSE_ANIMATION_FINISHED"
        ? initialConnectPanelSnapshot()
        : snapshot;
  }
}

function isCloseEvent(event: ConnectPanelEvent): boolean {
  return event.type === "EYES_CLICKED" || event.type === "ESCAPE_PRESSED" || event.type === "CLOSE_REQUESTED";
}

function panel(
  state: ConnectPanelState,
  messageCode: ConnectPanelMessageCode | undefined,
  messageTone: ConnectPanelMessageTone
): ConnectPanelSnapshot {
  return { state, ...(messageCode ? { messageCode } : {}), messageTone };
}
