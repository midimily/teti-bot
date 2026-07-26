#!/usr/bin/env node

const args = process.argv.slice(2);
const required = [
  "-p",
  "--input-format",
  "text",
  "--output-format",
  "stream-json",
  "--tools",
  "--disallowedTools",
  "*",
  "--permission-mode",
  "dontAsk",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--max-turns"
];
if (required.some((value) => !args.includes(value))
  || args.includes("--dangerously-skip-permissions")
  || args.includes("bypassPermissions")
  || !["0", "1"].includes(args[args.indexOf("--max-turns") + 1])) {
  process.stderr.write("fake CodeBuddy received an unsafe launch shape\n");
  process.exit(20);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks).toString("utf8");
const maxTurns = args[args.indexOf("--max-turns") + 1];
const answer = maxTurns === "0"
  ? "Max turns (0) exceeded"
  : `codebuddy:${input}`;

write({
  type: "system",
  subtype: "init",
  session_id: "private-session",
  cwd: "/must-not-project",
  tools: []
});
write({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: answer }]
  },
  session_id: "private-session"
});
write({
  type: "result",
  subtype: maxTurns === "0" ? "error_during_execution" : "success",
  is_error: maxTurns === "0",
  ...(maxTurns === "0" ? { errors: [answer] } : { result: answer }),
  session_id: "private-session",
  total_cost_usd: 0
});

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
