import { createDesktopFormatters } from "./format.ts";
import { EN_MESSAGES } from "./locales/en.ts";
import { ZH_HANS_MESSAGES } from "./locales/zh-hans.ts";
import type { AppLocale, AppMessages, DesktopI18n } from "./types.ts";

export {
  DEFAULT_APP_LOCALE,
  resolveAppLocale,
  resolveAppLocaleFromNavigator
} from "./locale.ts";
export type {
  AppLanguageSettings,
  AppLocale,
  AppLocalePreference,
  AppMessages,
  DesktopFormatters,
  DesktopI18n,
  FormatPluralOptions,
  PluralCategory,
  PluralMessages,
  TextDirection
} from "./types.ts";
export type { NavigatorLanguagePreferences } from "./locale.ts";
export {
  APP_LOCALE_PREFERENCE_STORAGE_KEY,
  readAppLocalePreference,
  resolveAppLocalePreference,
  writeAppLocalePreference
} from "./preference.ts";
export type { LocalePreferenceStorage } from "./preference.ts";
export {
  readPersistedAppLocalePreference,
  writePersistedAppLocalePreference
} from "./persistence.ts";
export { formatMessage } from "./message.ts";

const MESSAGE_CATALOGS: Record<AppLocale, AppMessages> = {
  en: EN_MESSAGES,
  "zh-Hans": ZH_HANS_MESSAGES
};

export function createDesktopI18n(locale: AppLocale): DesktopI18n {
  return {
    locale,
    direction: "ltr",
    messages: MESSAGE_CATALOGS[locale],
    ...createDesktopFormatters(locale)
  };
}

export function applyDocumentLocale(
  document: Pick<Document, "documentElement">,
  i18n: Pick<DesktopI18n, "locale" | "direction">
): void {
  document.documentElement.lang = i18n.locale;
  document.documentElement.dir = i18n.direction;
}
