import { createDesktopApp } from "./app.ts";
import { createTauriInvoker } from "./platform/tauri-api.ts";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Teti Desktop root element is missing.");
}

const tauri = await createTauriInvoker();
await createDesktopApp({
  root,
  tauri,
  env: import.meta.env
});
