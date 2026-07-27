import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const mode = process.argv[2] ?? "echo";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks).toString("utf8");

switch (mode) {
  case "echo":
    process.stdout.write(`fake:${input}`);
    break;

  case "fail":
    process.stderr.write("fake agent failed without sensitive diagnostics\n");
    process.exitCode = 7;
    break;

  case "exit-signal":
    process.kill(process.pid, "SIGKILL");
    break;

  case "overflow":
    process.stdout.write("x".repeat(8 * 1024));
    keepAlive();
    break;

  case "hang":
    process.on("SIGTERM", () => undefined);
    keepAlive();
    break;

  case "child-tree": {
    process.on("SIGTERM", () => undefined);
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
    ], { stdio: "ignore" });
    await writeFile(
      join(process.cwd(), "fake-process-tree.json"),
      JSON.stringify({ parentPid: process.pid, childPid: child.pid }),
      "utf8"
    );
    keepAlive();
    break;
  }

  case "image": {
    const path = join(process.cwd(), "output.png");
    await writeFile(path, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+pkJZ5QAAAABJRU5ErkJggg==",
      "base64"
    ));
    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      text: "fake:image-complete",
      images: [{ path }]
    }));
    break;
  }

  default:
    process.stderr.write("unknown fake mode\n");
    process.exitCode = 9;
}

function keepAlive() {
  setInterval(() => undefined, 1_000);
}
