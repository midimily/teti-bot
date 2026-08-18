import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const localizedSurfaces = [
  new URL("../src/app.ts", import.meta.url),
  new URL("../src/first-launch/view-model.ts", import.meta.url),
  new URL("../src/passport/view.ts", import.meta.url),
  new URL("../src/passport/view-model.ts", import.meta.url),
  new URL("../src/codex-usage/presentation.ts", import.meta.url),
  new URL("../src/memory/message.ts", import.meta.url),
  new URL("../src/tasks/view.ts", import.meta.url),
  new URL("../src/connections/remote-teti-avatar.ts", import.meta.url),
  new URL("../src-tauri/src/lib.rs", import.meta.url)
];

const violations: string[] = [];
const allowedVisibleLiterals = new Set(["AI"]);
for (const url of localizedSurfaces) {
  const source = await readFile(url, "utf8");
  source.split("\n").forEach((line, index) => {
    if (/\p{Script=Han}/u.test(line)) {
      violations.push(`${fileURLToPath(url)}:${index + 1}: ${line.trim()}`);
    }
    for (const match of line.matchAll(
      /(?:textContent|placeholder|title)\s*=\s*["'`]([^"'`]*)["'`]/g
    )) {
      const value = match[1] ?? "";
      const staticCopy = value.replace(/\$\{[^}]*\}/g, "").trim();
      if (
        /[A-Za-z\p{Script=Han}]/u.test(staticCopy)
        && !allowedVisibleLiterals.has(staticCopy)
      ) {
        violations.push(
          `${fileURLToPath(url)}:${index + 1}: visible literal ${JSON.stringify(value)}`
        );
      }
    }
  });
}

const localeDirectory = new URL("../src/i18n/locales/", import.meta.url);
const catalogFiles = (await readdir(localeDirectory))
  .filter((name) => name.endsWith(".ts"))
  .sort();
const expectedCatalogFiles = ["en.ts", "zh-hans.ts"];
if (JSON.stringify(catalogFiles) !== JSON.stringify(expectedCatalogFiles)) {
  violations.push(
    `${fileURLToPath(localeDirectory)}: expected only shared catalogs ${expectedCatalogFiles.join(", ")}; found ${catalogFiles.join(", ")}`
  );
}

if (violations.length > 0) {
  throw new Error(`Localized UI copy must live in the typed catalogs:\n${violations.join("\n")}`);
}

console.log(
  `Localized-copy guard passed for ${localizedSurfaces.length} presentation surfaces and ${catalogFiles.length} shared catalogs.`
);
