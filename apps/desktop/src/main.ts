import { createDesktopApp, renderDesktopStartupFailure } from "./app.ts";
import {
  createDesktopI18n,
  readPersistedAppLocalePreference,
  resolveAppLocalePreference,
  writePersistedAppLocalePreference,
  type LocalePreferenceStorage
} from "./i18n/index.ts";
import { createTauriInvoker } from "./platform/tauri-api.ts";
import { bootstrapDesktopApp } from "./startup.ts";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Teti Desktop root element is missing.");
}

const env = import.meta.env;
const localePreferenceStorage = safeLocalePreferenceStorage(window);
const tauriPromise = createTauriInvoker();
const tauri = await tauriPromise.catch(() => undefined);
const localePreference = await readPersistedAppLocalePreference(tauri, localePreferenceStorage);
const i18n = createDesktopI18n(resolveAppLocalePreference(localePreference, window.navigator));
const app = await bootstrapDesktopApp({
  root,
  env,
  i18n,
  createTauri: () => tauriPromise,
  createApp: (options) => createDesktopApp({
    ...options,
    localePreference,
    onLocalePreferenceChange: (preference) => {
      void writePersistedAppLocalePreference(tauri, localePreferenceStorage, preference)
        .then((written) => {
          if (written) window.location.reload();
        });
    }
  }),
  renderFailure: () => renderDesktopStartupFailure(root, env, i18n)
});

if (app) {
  const dispose = () => app.dispose();
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("beforeunload", dispose, { once: true });
}

function safeLocalePreferenceStorage(
  currentWindow: Pick<Window, "localStorage">
): LocalePreferenceStorage | undefined {
  try {
    return currentWindow.localStorage;
  } catch {
    return undefined;
  }
}
