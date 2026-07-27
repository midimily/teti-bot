#!/usr/bin/env node

import { createInterface } from "node:readline";

const imagePath = process.env.TETI_FAKE_CODEX_IMAGE_PATH;
if (!imagePath?.startsWith("/")) process.exit(64);
const resultBytes = boundedResultBytes(process.env.TETI_FAKE_CODEX_RESULT_BYTES);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, {
      userAgent: "fake-codex-image-app-server",
      platformFamily: "unix",
      platformOs: "darwin"
    });
    return;
  }
  if (message.method === "thread/start") {
    respond(message.id, { thread: { id: "fake-image-thread" } });
    return;
  }
  if (message.method === "turn/start") {
    respond(message.id, { turn: { id: "fake-image-turn" } });
    notify("item/completed", {
      item: {
        id: "fake-image-result",
        type: "imageGeneration",
        status: "completed",
        result: `must-not-project:${"A".repeat(resultBytes)}`,
        revisedPrompt: null,
        savedPath: imagePath
      }
    }, () => setTimeout(() => process.exit(7), 5));
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method, params, callback) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`, callback);
}

function boundedResultBytes(value) {
  if (value === undefined) return 2 * 1024 * 1024 + 64 * 1024;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 16 * 1024 * 1024
    ? parsed
    : 0;
}
