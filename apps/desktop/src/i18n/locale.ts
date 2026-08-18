import type { AppLocale } from "./types.ts";

export const DEFAULT_APP_LOCALE: AppLocale = "en";

export interface NavigatorLanguagePreferences {
  readonly language?: string;
  readonly languages?: readonly string[];
}

/**
 * Beta 0.4.0 follows the operating system's primary preferred language.
 * Every Chinese locale intentionally uses the Simplified Chinese catalog;
 * every other or unavailable locale falls back to English.
 */
export function resolveAppLocale(
  preferredLanguages: readonly string[] | null | undefined
): AppLocale {
  const primary = preferredLanguages?.[0]?.trim();
  if (!primary) return DEFAULT_APP_LOCALE;
  return /^zh(?:-|$)/i.test(primary) ? "zh-Hans" : "en";
}

export function resolveAppLocaleFromNavigator(
  preferences: NavigatorLanguagePreferences
): AppLocale {
  const languages = preferences.languages?.length
    ? preferences.languages
    : preferences.language
      ? [preferences.language]
      : [];
  return resolveAppLocale(languages);
}
