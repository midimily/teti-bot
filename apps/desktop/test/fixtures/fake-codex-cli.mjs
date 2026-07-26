#!/usr/bin/env node

const args = process.argv.slice(2);

if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using fake ChatGPT auth\n");
  process.exit(0);
}

const required = [
  "exec",
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
  "--color",
  "never",
  "shell_tool",
  "unified_exec",
  "-"
];
if (required.some((value) => !args.includes(value))) {
  process.stderr.write("fake Codex received an unsafe launch shape\n");
  process.exit(20);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks).toString("utf8");

write({ type: "thread.started", thread_id: "fake-private-thread" });
write({ type: "turn.started" });
write({
  type: "item.completed",
  item: {
    type: "command_execution",
    command: "must-not-project",
    aggregated_output: "must-not-project"
  }
});
write({
  type: "item.completed",
  item: { type: "agent_message", text: `codex:${input}` }
});
write({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
