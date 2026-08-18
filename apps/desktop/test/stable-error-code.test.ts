import assert from "node:assert/strict";
import test from "node:test";
import { readStableErrorCode } from "../src/errors/stable-error-code.ts";

test("stable error reader accepts explicit codes and ignores human messages", () => {
  const lifecycleError = new Error("private path /Users/example and token=secret");
  lifecycleError.name = "TASK_TRANSPORT_FAILED";

  assert.equal(readStableErrorCode(lifecycleError), "TASK_TRANSPORT_FAILED");
  assert.equal(
    readStableErrorCode({ code: "TASK_RESULT_IMAGE_OPEN_FAILED", message: "private detail" }),
    "TASK_RESULT_IMAGE_OPEN_FAILED"
  );
  assert.equal(readStableErrorCode(new Error("TASK_TRANSPORT_FAILED")), undefined);
  assert.equal(readStableErrorCode("arbitrary backend message"), undefined);
});
