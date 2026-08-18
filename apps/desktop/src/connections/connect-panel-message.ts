import type { ConnectPanelMessageCode } from "./connect-panel-state.ts";
import type { DesktopI18n } from "../i18n/index.ts";

export function connectPanelMessage(
  code: ConnectPanelMessageCode | undefined,
  i18n: DesktopI18n
): string {
  return code ? i18n.messages.connections.panel.messages[code] : "";
}
