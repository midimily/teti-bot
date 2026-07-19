export type ConnectPanelState =
  | "idle"
  | "opening"
  | "editing"
  | "connecting"
  | "success"
  | "error"
  | "closing";

export type ConnectPanelMessageTone = "hint" | "progress" | "success" | "error";

export interface ConnectPanelSnapshot {
  state: ConnectPanelState;
  message: string;
  messageTone: ConnectPanelMessageTone;
}

export type ConnectPanelEvent =
  | { type: "EYES_CLICKED" }
  | { type: "OPEN_ANIMATION_FINISHED" }
  | { type: "INPUT_CHANGED" }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "SUBMIT" }
  | { type: "CONNECT_SUCCEEDED"; message: string }
  | { type: "CONNECT_FAILED"; message: string }
  | { type: "ESCAPE_PRESSED" }
  | { type: "CLOSE_REQUESTED" }
  | { type: "CLOSE_ANIMATION_FINISHED" }
  | { type: "SUCCESS_TIMEOUT" }
  | { type: "RESET" };

export const CONNECT_PANEL_PLACEHOLDER = "*********（teti.bot 社区9位ID）";
export const CONNECT_PANEL_CONNECTING = "正在建立连接…";

export function initialConnectPanelSnapshot(): ConnectPanelSnapshot {
  return {
    state: "idle",
    message: "",
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
        ? panel("opening", "", "hint")
        : snapshot;
    case "opening":
      return event.type === "OPEN_ANIMATION_FINISHED"
        ? panel("editing", "", "hint")
        : snapshot;
    case "editing":
      if (event.type === "INPUT_CHANGED") return panel("editing", "", "hint");
      if (event.type === "VALIDATION_FAILED") return panel("error", event.message, "error");
      if (event.type === "SUBMIT") return panel("connecting", CONNECT_PANEL_CONNECTING, "progress");
      if (isCloseEvent(event)) return panel("closing", "", "hint");
      return snapshot;
    case "connecting":
      if (event.type === "CONNECT_SUCCEEDED") return panel("success", event.message, "success");
      if (event.type === "CONNECT_FAILED") return panel("error", event.message, "error");
      return snapshot;
    case "success":
      if (event.type === "SUCCESS_TIMEOUT" || isCloseEvent(event)) {
        return panel("closing", "", "hint");
      }
      return snapshot;
    case "error":
      if (event.type === "INPUT_CHANGED") return panel("editing", "", "hint");
      if (event.type === "VALIDATION_FAILED") return panel("error", event.message, "error");
      if (event.type === "SUBMIT") return panel("connecting", CONNECT_PANEL_CONNECTING, "progress");
      if (isCloseEvent(event)) return panel("closing", "", "hint");
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
  message: string,
  messageTone: ConnectPanelMessageTone
): ConnectPanelSnapshot {
  return { state, message, messageTone };
}
