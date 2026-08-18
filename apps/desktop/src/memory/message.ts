import type { MemoryUiErrorCode } from "./controller.ts";
import type { DesktopI18n } from "../i18n/index.ts";

export function memoryErrorMessage(code: MemoryUiErrorCode, i18n: DesktopI18n): string {
  return i18n.messages.memory.errors[code];
}
