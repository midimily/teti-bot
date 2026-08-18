import assert from "node:assert/strict";
import test from "node:test";
import {
  initialConnectPanelSnapshot,
  transitionConnectPanel,
  type ConnectPanelSnapshot
} from "../src/connections/connect-panel-state.ts";

test("connect panel starts idle without reserving message state", () => {
  assert.deepEqual(initialConnectPanelSnapshot(), {
    state: "idle",
    messageTone: "hint"
  });
});

test("eyes open the editor through one ordered opening transition", () => {
  const idle = initialConnectPanelSnapshot();
  const opening = transitionConnectPanel(idle, { type: "EYES_CLICKED" });

  assert.deepEqual(opening, {
    state: "opening",
    messageTone: "hint"
  });
  assert.equal(transitionConnectPanel(opening, { type: "EYES_CLICKED" }), opening);
  assert.equal(
    transitionConnectPanel(opening, { type: "OPEN_ANIMATION_FINISHED" }).state,
    "editing"
  );
});

test("editing, connecting, success and closing use one deterministic state path", () => {
  let snapshot = editingSnapshot();
  snapshot = transitionConnectPanel(snapshot, { type: "SUBMIT" });
  assert.deepEqual(snapshot, {
    state: "connecting",
    messageCode: "connecting",
    messageTone: "progress"
  });

  assert.equal(transitionConnectPanel(snapshot, { type: "SUBMIT" }), snapshot);
  assert.equal(transitionConnectPanel(snapshot, { type: "ESCAPE_PRESSED" }), snapshot);

  snapshot = transitionConnectPanel(snapshot, {
    type: "CONNECT_SUCCEEDED",
    messageCode: "connected"
  });
  assert.deepEqual(snapshot, {
    state: "success",
    messageCode: "connected",
    messageTone: "success"
  });

  snapshot = transitionConnectPanel(snapshot, { type: "SUCCESS_TIMEOUT" });
  assert.equal(snapshot.state, "closing");
  assert.equal(transitionConnectPanel(snapshot, { type: "EYES_CLICKED" }), snapshot);
  assert.deepEqual(
    transitionConnectPanel(snapshot, { type: "CLOSE_ANIMATION_FINISHED" }),
    initialConnectPanelSnapshot()
  );
});

test("errors retain a recoverable editor and clear as soon as input changes", () => {
  let snapshot = transitionConnectPanel(editingSnapshot(), {
    type: "VALIDATION_FAILED",
    messageCode: "invalid_public_id"
  });
  assert.deepEqual(snapshot, {
    state: "error",
    messageCode: "invalid_public_id",
    messageTone: "error"
  });

  snapshot = transitionConnectPanel(snapshot, { type: "INPUT_CHANGED" });
  assert.deepEqual(snapshot, {
    state: "editing",
    messageTone: "hint"
  });
});

test("editing, success and error can close while connecting cannot", () => {
  for (const snapshot of [
    editingSnapshot(),
    { state: "success", messageCode: "connected", messageTone: "success" } as const,
    { state: "error", messageCode: "connection_failed", messageTone: "error" } as const
  ]) {
    assert.equal(transitionConnectPanel(snapshot, { type: "ESCAPE_PRESSED" }).state, "closing");
  }

  const connecting: ConnectPanelSnapshot = {
    state: "connecting",
    messageCode: "connecting",
    messageTone: "progress"
  };
  assert.equal(transitionConnectPanel(connecting, { type: "CLOSE_REQUESTED" }), connecting);
});

function editingSnapshot(): ConnectPanelSnapshot {
  return {
    state: "editing",
    messageTone: "hint"
  };
}
