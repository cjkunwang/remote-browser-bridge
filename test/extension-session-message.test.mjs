import test from "node:test";
import assert from "node:assert/strict";
import { grantOptionsFromMessage } from "../extension/session-message.js";

test("grant message preserves the pending target requested by the popup", () => {
  assert.deepEqual(grantOptionsFromMessage({
    type: "session",
    action: "grant",
    scope: "origin",
    durationMinutes: 30,
    origin: "https://example.com",
    tabId: 17
  }), {
    scope: "origin",
    durationMinutes: 30,
    origin: "https://example.com",
    tabId: 17
  });
});

test("grant message drops unrelated fields and invalid tab ids", () => {
  assert.deepEqual(grantOptionsFromMessage({
    scope: "all",
    durationMinutes: 15,
    origin: "",
    tabId: -1,
    token: "must-not-be-forwarded"
  }), {
    scope: "all",
    durationMinutes: 15,
    origin: null,
    tabId: null
  });
});
