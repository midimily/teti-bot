import { createDesktopApp, renderDesktopStartupFailure } from "./app.ts";
import { createTauriInvoker } from "./platform/tauri-api.ts";
import { bootstrapDesktopApp } from "./startup.ts";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Teti Desktop root element is missing.");
}

const env = import.meta.env;
const app = await bootstrapDesktopApp({
  root,
  env,
  createTauri: createTauriInvoker,
  createApp: createDesktopApp,
  renderFailure: () => renderDesktopStartupFailure(root, env)
});

if (app) {
  const dispose = () => app.dispose();
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("beforeunload", dispose, { once: true });
}
