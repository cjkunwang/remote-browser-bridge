import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  isAllowedHttpUrl,
  safeTokenEqual,
  sanitizeDeviceId,
  validateCommand,
  ValidationError
} from "../server/protocol.mjs";

test("protocol exposes the supported command actions", () => {
  assert.ok(ACTIONS.includes("tab.open"));
  assert.ok(ACTIONS.includes("tab.close"));
  assert.ok(ACTIONS.includes("page.click"));
});

test("HTTP URL validation blocks privileged browser and local schemes", () => {
  assert.equal(isAllowedHttpUrl("https://example.com"), true);
  assert.equal(isAllowedHttpUrl("http://127.0.0.1:3000"), true);
  assert.equal(isAllowedHttpUrl("chrome://settings"), false);
  assert.equal(isAllowedHttpUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedHttpUrl("javascript:alert(1)"), false);
});

test("device ids and tokens are validated without prefix shortcuts", () => {
  assert.equal(sanitizeDeviceId("chrome_0123456789abcdef"), "chrome_0123456789abcdef");
  assert.equal(sanitizeDeviceId("bad id"), null);
  assert.equal(safeTokenEqual("same-token", "same-token"), true);
  assert.equal(safeTokenEqual("same-token", "same-toke"), false);
});

test("tab open commands normalize timeout and payload", () => {
  const command = validateCommand({
    deviceId: "chrome_0123456789abcdef",
    action: "tab.open",
    payload: { url: "https://example.com" }
  });
  assert.equal(command.timeoutMs, 15_000);
  assert.equal(command.payload.url, "https://example.com");
});

test("dangerous URL and malformed selectors are rejected", () => {
  assert.throws(() => validateCommand({
    deviceId: "chrome_0123456789abcdef",
    action: "tab.open",
    payload: { url: "file:///etc/passwd" }
  }), ValidationError);

  assert.throws(() => validateCommand({
    deviceId: "chrome_0123456789abcdef",
    action: "page.click",
    payload: { tabId: 1, selector: "" }
  }), ValidationError);
});
