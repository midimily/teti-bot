import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APP_LOCALE_PREFERENCE_STORAGE_KEY,
  applyDocumentLocale,
  createDesktopI18n,
  readAppLocalePreference,
  readPersistedAppLocalePreference,
  resolveAppLocale,
  resolveAppLocaleFromNavigator,
  resolveAppLocalePreference,
  writeAppLocalePreference,
  writePersistedAppLocalePreference,
  type LocalePreferenceStorage
} from "../src/i18n/index.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";

test("all primary Chinese locale variants resolve to Simplified Chinese", () => {
  for (const locale of [
    "zh",
    "zh-CN",
    "zh-SG",
    "zh-Hans",
    "zh-Hans-CN",
    "zh-TW",
    "zh-HK",
    "zh-Hant",
    "zh-Hant-TW",
    "ZH-hant-hk"
  ]) {
    assert.equal(resolveAppLocale([locale]), "zh-Hans", locale);
  }
});

test("non-Chinese, missing, and invalid primary locales resolve to English", () => {
  for (const languages of [
    ["en"],
    ["en-US"],
    ["ja-JP"],
    ["ko-KR"],
    ["not_a_locale"],
    [""],
    [],
    null,
    undefined
  ] as const) {
    assert.equal(resolveAppLocale(languages), "en");
  }
});

test("only the operating system primary preferred language selects the App locale", () => {
  assert.equal(resolveAppLocale(["en-US", "zh-Hant"]), "en");
  assert.equal(resolveAppLocale(["zh-Hant", "en-US"]), "zh-Hans");
  assert.equal(resolveAppLocaleFromNavigator({ languages: ["zh-HK"], language: "en-US" }), "zh-Hans");
  assert.equal(resolveAppLocaleFromNavigator({ languages: [], language: "zh-TW" }), "zh-Hans");
  assert.equal(resolveAppLocaleFromNavigator({}), "en");
});

test("language preference defaults to automatic detection and safely persists forced locales", () => {
  const values = new Map<string, string>();
  const storage: LocalePreferenceStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }
  };

  assert.equal(readAppLocalePreference(storage), "auto");
  assert.equal(resolveAppLocalePreference("auto", { languages: ["zh-HK"] }), "zh-Hans");
  assert.equal(resolveAppLocalePreference("en", { languages: ["zh-HK"] }), "en");
  assert.equal(resolveAppLocalePreference("zh-Hans", { languages: ["en-US"] }), "zh-Hans");

  assert.equal(writeAppLocalePreference(storage, "zh-Hans"), true);
  assert.equal(readAppLocalePreference(storage), "zh-Hans");
  assert.equal(values.get(APP_LOCALE_PREFERENCE_STORAGE_KEY), "zh-Hans");
  assert.equal(writeAppLocalePreference(storage, "auto"), true);
  assert.equal(values.has(APP_LOCALE_PREFERENCE_STORAGE_KEY), false);

  values.set(APP_LOCALE_PREFERENCE_STORAGE_KEY, "unsupported-locale");
  assert.equal(readAppLocalePreference(storage), "auto");
  assert.equal(readAppLocalePreference({
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => undefined,
    removeItem: () => undefined
  }), "auto");
});

test("automatic and forced locale selection covers the Windows OS locale matrix", () => {
  const automaticCases = [
    { osLocale: "zh-CN", expected: "zh-Hans" },
    { osLocale: "zh-TW", expected: "zh-Hans" },
    { osLocale: "en-US", expected: "en" },
    { osLocale: "ja-JP", expected: "en" },
    { osLocale: "fr-FR", expected: "en" }
  ] as const;
  for (const { osLocale, expected } of automaticCases) {
    assert.equal(
      resolveAppLocalePreference("auto", { languages: [osLocale] }),
      expected,
      osLocale
    );
  }

  for (const osLocale of ["zh-CN", "zh-TW", "en-US", "ja-JP"]) {
    assert.equal(resolveAppLocalePreference("en", { languages: [osLocale] }), "en");
    assert.equal(
      resolveAppLocalePreference("zh-Hans", { languages: [osLocale] }),
      "zh-Hans"
    );
  }
});

test("document language metadata follows the resolved shared locale", () => {
  const documentElement = { lang: "", dir: "" };
  applyDocumentLocale(
    { documentElement } as Pick<Document, "documentElement">,
    createDesktopI18n("zh-Hans")
  );
  assert.deepEqual(documentElement, { lang: "zh-Hans", dir: "ltr" });

  applyDocumentLocale(
    { documentElement } as Pick<Document, "documentElement">,
    createDesktopI18n("en")
  );
  assert.deepEqual(documentElement, { lang: "en", dir: "ltr" });
});

test("Desktop startup reads the language preference and reloads after a successful change", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /readPersistedAppLocalePreference\(tauri, localePreferenceStorage\)/);
  assert.match(source, /resolveAppLocalePreference\(localePreference, window\.navigator\)/);
  assert.match(source, /writePersistedAppLocalePreference\(tauri, localePreferenceStorage, preference\)/);
  assert.match(source, /window\.location\.reload\(\)/);
});

test("beta.1 WebView language preference migrates into the protected native Profile", async () => {
  const values = new Map([[APP_LOCALE_PREFERENCE_STORAGE_KEY, "zh-Hans"]]);
  const storage: LocalePreferenceStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }
  };
  const tauri = new RecordingTauriInvoker();
  Object.defineProperty(tauri, "runtime", { value: "native" });
  tauri.responses.set("read_app_locale_preference", null);

  assert.equal(await readPersistedAppLocalePreference(tauri, storage), "zh-Hans");
  assert.deepEqual(tauri.calls, [
    { command: "read_app_locale_preference", args: undefined },
    { command: "write_app_locale_preference", args: { preference: "zh-Hans" } }
  ]);
});

test("native Profile preference wins and forced locale writes both persistence layers", async () => {
  const values = new Map([[APP_LOCALE_PREFERENCE_STORAGE_KEY, "zh-Hans"]]);
  const storage: LocalePreferenceStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }
  };
  const tauri = new RecordingTauriInvoker();
  Object.defineProperty(tauri, "runtime", { value: "native" });
  tauri.responses.set("read_app_locale_preference", "en");

  assert.equal(await readPersistedAppLocalePreference(tauri, storage), "en");
  assert.equal(await writePersistedAppLocalePreference(tauri, storage, "en"), true);
  assert.equal(values.get(APP_LOCALE_PREFERENCE_STORAGE_KEY), "en");
  assert.deepEqual(tauri.calls.at(-1), {
    command: "write_app_locale_preference",
    args: { preference: "en" }
  });
});

test("English and Simplified Chinese catalogs expose typed common copy", () => {
  const english = createDesktopI18n("en");
  const chinese = createDesktopI18n("zh-Hans");

  assert.equal(english.messages.common.actions.save, "Save");
  assert.equal(chinese.messages.common.actions.save, "保存");
  assert.equal(english.messages.common.unknown, "Unknown");
  assert.equal(chinese.messages.common.unknown, "未知");
  assert.equal(english.direction, "ltr");
  assert.equal(chinese.direction, "ltr");
});

test("number and plural formatters follow the selected locale", () => {
  const english = createDesktopI18n("en");
  const chinese = createDesktopI18n("zh-Hans");

  assert.equal(english.formatNumber(12_345.6), "12,345.6");
  assert.equal(english.pluralCategory(1), "one");
  assert.equal(english.pluralCategory(2), "other");
  assert.equal(english.formatPlural(1, english.messages.common.units.items), "1 item");
  assert.equal(english.formatPlural(2, english.messages.common.units.items), "2 items");
  assert.equal(chinese.formatPlural(1, chinese.messages.common.units.items), "1 项");
  assert.equal(chinese.formatPlural(2, chinese.messages.common.units.days), "2 天");
});

test("date and date-time formatters use locale-aware Intl output", () => {
  const english = createDesktopI18n("en");
  const chinese = createDesktopI18n("zh-Hans");
  const instant = Date.UTC(2026, 0, 2, 15, 4);
  const dateOptions = {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric"
  } as const;
  const dateTimeOptions = {
    ...dateOptions,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  } as const;

  assert.match(english.formatDate(instant, dateOptions), /January 2, 2026/);
  assert.match(chinese.formatDate(instant, dateOptions), /2026年1月2日/);
  assert.match(english.formatDateTime(instant, dateTimeOptions), /15:04/);
  assert.match(chinese.formatDateTime(instant, dateTimeOptions), /15:04/);
});
