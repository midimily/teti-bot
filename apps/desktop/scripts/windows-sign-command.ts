import { resolve } from "node:path";
import {
  isWindowsReleaseSigningEnabled,
  signWindowsPeFile
} from "./windows-authenticode.ts";

const input = process.argv[2];
if (!input) throw new Error("Tauri Windows signCommand did not provide an artifact path.");

if (!isWindowsReleaseSigningEnabled()) {
  console.log("Teti development build: Authenticode signing skipped.");
} else {
  const path = resolve(input);
  const signature = await signWindowsPeFile(path);
  console.log(`Signed and verified ${path} (${signature.signerSubject}).`);
}
