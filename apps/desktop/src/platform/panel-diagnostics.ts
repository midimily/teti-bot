import { TETI_BUILD_INFO, type TetiBuildInfo } from "../build-info.ts";
import type { TauriInvoker } from "./tauri-api.ts";

export type PanelDiagnosticLevel = "debug" | "info" | "warn" | "error";
export type PanelDiagnosticValue = string | number | boolean;

export interface PanelDiagnosticEntry {
  level: PanelDiagnosticLevel;
  event: string;
  fields?: Record<string, PanelDiagnosticValue | undefined>;
}

export type PanelDiagnosticSink = (entry: PanelDiagnosticEntry) => void;

export function createPanelDiagnosticSink(
  tauri: TauriInvoker,
  buildType: TetiBuildInfo["buildType"] = TETI_BUILD_INFO.buildType
): PanelDiagnosticSink {
  if (tauri.runtime !== "native") return () => undefined;
  return (entry) => {
    if (!shouldPersistPanelDiagnostic(buildType, entry.level)) return;
    const fields = Object.fromEntries(
      Object.entries(entry.fields ?? {}).filter(
        (field): field is [string, PanelDiagnosticValue] => field[1] !== undefined
      )
    );
    void tauri.invoke("write_panel_diagnostic", {
      entry: {
        occurredAt: new Date().toISOString(),
        level: entry.level,
        event: entry.event,
        fields
      }
    }).catch(() => undefined);
  };
}

export function shouldPersistPanelDiagnostic(
  buildType: TetiBuildInfo["buildType"],
  level: PanelDiagnosticLevel
): boolean {
  return buildType === "development" || level === "warn" || level === "error";
}
