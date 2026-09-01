import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LogLevel } from "@microsoft/signalr";
import { desktopSignalRLogLevel } from "./signalr-config.js";

test("Desktop suppresses SignalR information logs that contain access-token query strings", () => {
  assert.equal(desktopSignalRLogLevel, LogLevel.Warning);
});
