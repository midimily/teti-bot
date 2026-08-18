import type {
  AppLocale,
  DesktopFormatters,
  FormatPluralOptions,
  PluralCategory,
  PluralMessages
} from "./types.ts";

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = { dateStyle: "medium" };
const DEFAULT_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short"
};

export function createDesktopFormatters(locale: AppLocale): DesktopFormatters {
  const defaultNumberFormatter = new Intl.NumberFormat(locale);
  const defaultPluralRules = new Intl.PluralRules(locale);

  const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
    options
      ? new Intl.NumberFormat(locale, options).format(value)
      : defaultNumberFormatter.format(value);

  const pluralCategory = (
    value: number,
    options?: Intl.PluralRulesOptions
  ): PluralCategory => (
    options ? new Intl.PluralRules(locale, options) : defaultPluralRules
  ).select(value) as PluralCategory;

  const formatPlural = (
    value: number,
    messages: PluralMessages,
    options: FormatPluralOptions = {}
  ): string => {
    const category = pluralCategory(value, options.plural);
    const template = messages[category] ?? messages.other;
    return template.replaceAll("#", formatNumber(value, options.number));
  };

  return {
    formatDate: (value, options = DEFAULT_DATE_OPTIONS) =>
      new Intl.DateTimeFormat(locale, options).format(value),
    formatDateTime: (value, options = DEFAULT_DATE_TIME_OPTIONS) =>
      new Intl.DateTimeFormat(locale, options).format(value),
    formatNumber,
    pluralCategory,
    formatPlural
  };
}
