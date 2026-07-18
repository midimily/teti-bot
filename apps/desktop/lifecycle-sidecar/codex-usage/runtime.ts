import { CodexUsageProvider } from "./provider.ts";
import { CodexUsageService } from "./service.ts";

let service: CodexUsageService | undefined;

export function getDefaultCodexUsageService(): CodexUsageService {
  service ??= new CodexUsageService({
    provider: new CodexUsageProvider({
      codexHome: process.env.TETI_CODEX_HOME
    }),
    onRefresh: (result) => {
      const outcome = result.ok ? "success" : `failure code=${result.error.code}`;
      process.stderr.write(`teti-codex-usage refresh ${outcome}\n`);
    }
  });
  return service;
}
