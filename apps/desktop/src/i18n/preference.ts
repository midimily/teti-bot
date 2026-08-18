import { resolveAppLocaleFromNavigator, type NavigatorLanguagePreferences } from "./locale.ts";
import type { AppLocale, AppLocalePreference } from "./types.ts";

export const APP_LOCALE_PREFERENCE_STORAGE_KEY = "teti.app.locale-preference.v1";

export interface LocalePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readAppLocalePreference(
  storage: LocalePreferenceStorage | null | undefined
): AppLocalePreference {
  if (!storage) return "auto";
  try {
    const value = storage.getItem(APP_LOCALE_PREFERENCE_STORAGE_KEY);
    return value === "zh-Hans" || value === "en" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeAppLocalePreference(
  storage: LocalePreferenceStorage | null | undefined,
  preference: AppLocalePreference
): boolean {
  if (!storage) return false;
  try {
    if (preference === "auto") storage.removeItem(APP_LOCALE_PREFERENCE_STORAGE_KEY);
    else storage.setItem(APP_LOCALE_PREFERENCE_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

export function resolveAppLocalePreference(
  preference: AppLocalePreference,
  navigatorLanguages: NavigatorLanguagePreferences
): AppLocale {
  return preference === "auto"
    ? resolveAppLocaleFromNavigator(navigatorLanguages)
    : preference;
}
