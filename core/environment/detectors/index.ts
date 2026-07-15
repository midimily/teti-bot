import { join } from "node:path";
import { homedir } from "node:os";
import type {
  DetectedAiTool,
  EnvironmentDetector,
  EnvironmentDetectorContext
} from "../types.ts";

export const defaultEnvironmentDetectors: EnvironmentDetector[] = [
  commandDetector("claude-code", "Claude Code", "claude"),
  mixedCommandOrAppDetector("cursor", "Cursor", "cursor", [
    "/Applications/Cursor.app",
    join(homedir(), "Applications", "Cursor.app")
  ]),
  commandDetector("codex", "Codex", "codex"),
  commandDetector("gemini-cli", "Gemini CLI", "gemini"),
  vscodeAiExtensionDetector()
];

function commandDetector(id: string, name: string, command: string): EnvironmentDetector {
  return {
    id,
    async detect(context) {
      return (await context.commandExists(command))
        ? [{ id, name, source: "command" }]
        : [];
    }
  };
}

function mixedCommandOrAppDetector(
  id: string,
  name: string,
  command: string,
  appPaths: string[]
): EnvironmentDetector {
  return {
    id,
    async detect(context) {
      if (await context.commandExists(command)) {
        return [{ id, name, source: "command" }];
      }

      for (const appPath of appPaths) {
        if (await context.pathExists(appPath)) {
          return [{ id, name, source: "application" }];
        }
      }

      return [];
    }
  };
}

function vscodeAiExtensionDetector(): EnvironmentDetector {
  const extensionDirectories = [
    join(homedir(), ".vscode", "extensions"),
    join(homedir(), ".cursor", "extensions")
  ];
  const knownExtensions: Array<{ pattern: RegExp; tool: DetectedAiTool }> = [
    {
      pattern: /github\.copilot/i,
      tool: { id: "github-copilot", name: "GitHub Copilot", source: "extension" }
    },
    {
      pattern: /anthropic|claude/i,
      tool: { id: "claude-extension", name: "Claude Extension", source: "extension" }
    },
    {
      pattern: /continue/i,
      tool: { id: "continue", name: "Continue", source: "extension" }
    },
    {
      pattern: /codeium|windsurf/i,
      tool: { id: "codeium", name: "Codeium/Windsurf", source: "extension" }
    },
    {
      pattern: /tabnine/i,
      tool: { id: "tabnine", name: "Tabnine", source: "extension" }
    }
  ];

  return {
    id: "vscode-ai-extensions",
    async detect(context: EnvironmentDetectorContext) {
      const found = new Map<string, DetectedAiTool>();
      for (const directory of extensionDirectories) {
        const entries = await context.listDirectory(directory);
        for (const entry of entries) {
          for (const extension of knownExtensions) {
            if (extension.pattern.test(entry)) {
              found.set(extension.tool.id, extension.tool);
            }
          }
        }
      }

      return [...found.values()];
    }
  };
}
