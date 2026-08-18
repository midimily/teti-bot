import type { TauriInvoker } from "../platform/tauri-api.ts";
import {
  readAppLocalePreference,
  writeAppLocalePreference,
  type LocalePreferenceStorage
} from "./preference.ts";
import type { AppLocalePreference } from "./types.ts";

function isAppLocalePreference(value: unknown): value is AppLocalePreference {
  return value === "auto" || value === "zh-Hans" || value === "en";
}

export async function readPersistedAppLocalePreference(
  tauri: TauriInvoker | undefined,
  storage: LocalePreferenceStorage | null | undefined
): Promise<AppLocalePreference> {
  const fallback = readAppLocalePreference(storage);
  if (tauri?.runtime !== "native") return fallback;

  try {
    const nativePreference = await tauri.invoke<unknown>("read_app_locale_preference");
    if (isAppLocalePreference(nativePreference)) return nativePreference;
    if (nativePreference !== null && nativePreference !== undefined) return fallback;

    // Beta 0.4.1-beta.1 stored this setting only in WebView localStorage.
    // Copy it into the protected Profile on the first beta.2 launch.
    if (fallback !== "auto") {
      await tauri.invoke<void>("write_app_locale_preference", { preference: fallback });
    }
  } catch {
    // A startup preference must never prevent the safe localized shell from opening.
  }
  return fallback;
}

export async function writePersistedAppLocalePreference(
  tauri: TauriInvoker | undefined,
  storage: LocalePreferenceStorage | null | undefined,
  preference: AppLocalePreference
): Promise<boolean> {
  let nativeWritten = false;
  if (tauri?.runtime === "native") {
    try {
      await tauri.invoke<void>("write_app_locale_preference", { preference });
      nativeWritten = true;
    } catch {
      return false;
    }
  }
  return writeAppLocalePreference(storage, preference) || nativeWritten;
}
