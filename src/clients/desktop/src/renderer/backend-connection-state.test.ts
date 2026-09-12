import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  applyBackendConnectionState,
  initialBackendConnectionState
} from "./backend-connection-state.js";

test("keeps a newer backend connection event when an older snapshot arrives later", () => {
  const connected = applyBackendConnectionState(initialBackendConnectionState, {
    state: "connected",
    revision: 2
  });
  const staleSnapshot = applyBackendConnectionState(connected, {
    state: "connecting",
    revision: 1
  });

  assert.equal(staleSnapshot, connected);
  assert.equal(staleSnapshot.state, "connected");
});

test("accepts the current backend connection snapshot after renderer startup", () => {
  const current = applyBackendConnectionState(initialBackendConnectionState, {
    state: "connected",
    revision: 1
  });

  assert.deepEqual(current, { state: "connected", revision: 1 });
});

test("ignores a duplicate backend connection revision", () => {
  const connected = applyBackendConnectionState(initialBackendConnectionState, {
    state: "connected",
    revision: 3
  });
  const duplicate = applyBackendConnectionState(connected, {
    state: "disconnected",
    revision: 3
  });

  assert.equal(duplicate, connected);
  assert.deepEqual(duplicate, { state: "connected", revision: 3 });
});
