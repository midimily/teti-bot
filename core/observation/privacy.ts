const FORBIDDEN_OBSERVATION_KEYS = new Set([
  "prompt",
  "prompts",
  "response",
  "responses",
  "message",
  "messages",
  "conversation",
  "conversationhistory",
  "history",
  "file",
  "files",
  "filename",
  "filenames",
  "path",
  "paths",
  "cwd",
  "project",
  "projectname",
  "repository",
  "repo",
  "branch",
  "command",
  "commands",
  "args",
  "arguments",
  "environment",
  "env",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "toolinput",
  "toolarguments",
  "sourcecode",
  "transcript",
  "transcriptpath",
  "pid",
  "ppid"
]);

export class ObservationPrivacyError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Observation contains forbidden field: ${field}`);
    this.name = "ObservationPrivacyError";
    this.field = field;
  }
}

export function assertPrivacySafeObservation(value: unknown): void {
  visit(value, "observation", new Set<object>());
}

export function isForbiddenObservationKey(key: string): boolean {
  return FORBIDDEN_OBSERVATION_KEYS.has(normalizeKey(key));
}

function visit(value: unknown, location: string, visited: Set<object>): void {
  if (!value || typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${location}[${index}]`, visited));
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenObservationKey(key)) {
      throw new ObservationPrivacyError(`${location}.${key}`);
    }
    visit(nested, `${location}.${key}`, visited);
  }
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
