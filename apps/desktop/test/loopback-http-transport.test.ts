import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  LoopbackHttpTransport,
  decodeLoopbackFailure,
  type LoopbackRuntimeIdentityVerifier
} from "../lifecycle-sidecar/runtime/callable/transports/loopback-http.ts";
import type {
  ExecutionTransportHandle,
  LoopbackHttpExecutionSpec
} from "../../../core/callability/agent-core.ts";

const MODEL = "OsaurusAI/Bonsai-27b-1bit-JANG";

test("Loopback HTTP sends one tool-free, memory-free, Workspace-free Bonsai request", async () => {
  let receivedBody: unknown;
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  const server = createServer(async (request, response) => {
    receivedHeaders = request.headers;
    receivedBody = JSON.parse(await readRequest(request));
    writeSuccessfulSse(response, "local answer");
  });
  const port = await listen(server);
  try {
    let listenerChecks = 0;
    let socketChecks = 0;
    const handle = transport({
      async verifyListener() { listenerChecks += 1; },
      async verifyConnectedSocket(input) {
        socketChecks += 1;
        assert.equal(input.serverPort, port);
        assert.ok(input.clientPort > 0);
      }
    }).start({ spec: spec(port), workspacePath: null });
    const output = captureStdout(handle);
    await handle.writeInput("hello local runtime");
    const exit = await handle.completion;
    const outputText = await output;
    assert.deepEqual(exit, { code: 0, signal: null }, outputText);
    assert.equal(outputText, "local answer");
    assert.equal(listenerChecks, 1);
    assert.equal(socketChecks, 1);
    assert.deepEqual(receivedBody, {
      model: MODEL,
      messages: [{ role: "user", content: "hello local runtime" }],
      stream: true,
      tools: []
    });
    assert.equal(receivedHeaders["x-persist"], "false");
    assert.equal(receivedHeaders["x-osaurus-agent-id"], undefined);
    assert.equal(receivedHeaders.authorization, undefined);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("a delayed first token remains a bounded local cold-start request", async () => {
  const server = createServer(async (request, response) => {
    await readRequest(request);
    await delay(75);
    writeSuccessfulSse(response, "cold model ready");
  });
  const port = await listen(server);
  try {
    const handle = transport(trustedVerifier()).start({ spec: spec(port), workspacePath: null });
    const output = captureStdout(handle);
    await handle.writeInput("wait for the local model");
    assert.deepEqual(await handle.completion, { code: 0, signal: null });
    assert.equal(await output, "cold model ready");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("redirects and malformed SSE fail closed without returning partial text", async () => {
  for (const responseKind of ["redirect", "malformed"] as const) {
    const server = createServer((_request, response) => {
      if (responseKind === "redirect") {
        response.writeHead(307, { Location: "https://example.invalid/steal" });
        response.end();
      } else {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end("data: {not-json}\n\n");
      }
    });
    const port = await listen(server);
    try {
      const handle = transport(trustedVerifier()).start({ spec: spec(port), workspacePath: null });
      const output = captureStdout(handle);
      await handle.writeInput("must stay local");
      assert.deepEqual(await handle.completion, { code: 1, signal: null });
      assert.equal(
        decodeLoopbackFailure(await output),
        responseKind === "redirect" ? "ADAPTER_RUNTIME_UNTRUSTED" : "ADAPTER_STREAM_INVALID"
      );
    } finally {
      server.close();
      await once(server, "close");
    }
  }
});

test("Osaurus model, memory, load, 503, and SSE failures map to bounded safe codes", async () => {
  const cases = [
    {
      status: 400,
      body: { error: { type: "invalid_request_error", message: "Model not found: Bonsai" } },
      expected: "ADAPTER_MODEL_UNAVAILABLE"
    },
    {
      status: 500,
      body: { error: { type: "insufficient_resources", message: "Not enough memory" } },
      expected: "ADAPTER_INSUFFICIENT_MEMORY"
    },
    {
      status: 500,
      body: { error: { type: "internal_error", message: "Failed to load model" } },
      expected: "ADAPTER_MODEL_LOAD_FAILED"
    },
    {
      status: 503,
      body: { error: { type: "server_overloaded", message: "At inference capacity" } },
      expected: "ADAPTER_RUNTIME_BUSY"
    }
  ] as const;

  for (const fixture of cases) {
    const server = createServer((_request, response) => {
      response.writeHead(fixture.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(fixture.body));
    });
    const port = await listen(server);
    try {
      const handle = transport(trustedVerifier()).start({ spec: spec(port), workspacePath: null });
      const output = captureStdout(handle);
      await handle.writeInput("map safely");
      assert.deepEqual(await handle.completion, { code: 1, signal: null });
      assert.equal(decodeLoopbackFailure(await output), fixture.expected);
    } finally {
      server.close();
      await once(server, "close");
    }
  }
});

test("terminating the HTTP handle closes the socket observed by the server", async () => {
  let resolveRequest!: () => void;
  const requestArrived = new Promise<void>((resolve) => { resolveRequest = resolve; });
  let resolveSocketClosed!: () => void;
  const socketClosed = new Promise<void>((resolve) => { resolveSocketClosed = resolve; });
  const server = createServer(async (request, response) => {
    await readRequest(request);
    resolveRequest();
    response.once("close", resolveSocketClosed);
  });
  const port = await listen(server);
  try {
    const handle = transport(trustedVerifier()).start({ spec: spec(port), workspacePath: null });
    await handle.writeInput("cancel this inference");
    await requestArrived;
    await handle.terminate(100);
    assert.deepEqual(await handle.completion, { code: null, signal: "SIGTERM" });
    await Promise.race([
      socketClosed,
      delay(1_000).then(() => { throw new Error("server did not observe the closed HTTP stream"); })
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

function transport(identityVerifier: LoopbackRuntimeIdentityVerifier) {
  return new LoopbackHttpTransport({ identityVerifier });
}

function trustedVerifier(): LoopbackRuntimeIdentityVerifier {
  return {
    async verifyListener() {},
    async verifyConnectedSocket() {}
  };
}

function spec(port: number): LoopbackHttpExecutionSpec {
  return {
    kind: "loopback_http",
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    requestId: "teti-osaurus-test",
    runtimeInstanceId: "11111111-1111-4111-8111-111111111111",
    model: MODEL,
    listenerPid: 4242,
    codeIdentityHash: `sha256:${"a".repeat(64)}`
  };
}

function writeSuccessfulSse(response: ServerResponse, content: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  response.end([
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: { content }, finish_reason: null }]
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}`,
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n"));
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return address.port;
}

async function readRequest(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function captureStdout(handle: ExecutionTransportHandle): Promise<string> {
  const chunks: Buffer[] = [];
  handle.stdout.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return new Promise((resolve) => {
    handle.stdout.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
