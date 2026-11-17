import { timingSafeEqual } from "node:crypto";

export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
export const MAX_COMMAND_TIMEOUT_MS = 60_000;

export const ACTIONS = Object.freeze([
  "session.status",
  "tab.list",
  "tab.open",
  "tab.navigate",
  "tab.close",
  "tab.activate",
  "tab.screenshot",
  "window.open",
  "window.close",
  "page.click",
  "page.type",
  "page.text",
  "page.waitForSelector",
  "page.scroll"
]);

const ACTIONS_WITH_TAB = new Set([
  "tab.navigate",
  "tab.close",
  "tab.activate",
  "tab.screenshot",
  "page.click",
  "page.type",
  "page.text",
  "page.waitForSelector",
  "page.scroll"
]);

const ACTIONS_WITH_SELECTOR = new Set([
  "page.click",
  "page.type",
  "page.text",
  "page.waitForSelector"
]);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export function isAllowedHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function safeTokenEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function sanitizeDeviceId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,100}$/.test(trimmed) ? trimmed : null;
}

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
}

function assertInteger(value, field, min = 0) {
  if (!Number.isInteger(value) || value < min) {
    throw new ValidationError(`${field} must be an integer >= ${min}`);
  }
}

function assertSelector(payload) {
  if (
    typeof payload.selector !== "string" ||
    payload.selector.trim().length === 0 ||
    payload.selector.length > 2_000
  ) {
    throw new ValidationError("payload.selector must be a non-empty string <= 2000 chars");
  }
}

export function validateCommand(input) {
  assertObject(input, "command");

  const deviceId = sanitizeDeviceId(input.deviceId);
  if (!deviceId) throw new ValidationError("deviceId is invalid");

  if (typeof input.action !== "string" || !ACTIONS.includes(input.action)) {
    throw new ValidationError(`action must be one of: ${ACTIONS.join(", ")}`);
  }

  const payload = input.payload ?? {};
  assertObject(payload, "payload");

  const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  assertInteger(timeoutMs, "timeoutMs", 1_000);
  if (timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new ValidationError(`timeoutMs must be <= ${MAX_COMMAND_TIMEOUT_MS}`);
  }

  if (ACTIONS_WITH_TAB.has(input.action) && payload.tabId !== undefined) {
    assertInteger(payload.tabId, "payload.tabId", 1);
  }

  if (ACTIONS_WITH_SELECTOR.has(input.action)) {
    assertSelector(payload);
  }

  switch (input.action) {
    case "tab.open":
    case "window.open":
      if (!isAllowedHttpUrl(payload.url)) {
        throw new ValidationError("payload.url must be an http(s) URL");
      }
      break;
    case "tab.navigate":
      assertInteger(payload.tabId, "payload.tabId", 1);
      if (!isAllowedHttpUrl(payload.url)) {
        throw new ValidationError("payload.url must be an http(s) URL");
      }
      break;
    case "tab.close":
    case "tab.activate":
      assertInteger(payload.tabId, "payload.tabId", 1);
      break;
    case "window.close":
      assertInteger(payload.windowId, "payload.windowId", 1);
      break;
    case "page.type":
      if (typeof payload.text !== "string" || payload.text.length > 100_000) {
        throw new ValidationError("payload.text must be a string <= 100000 chars");
      }
      break;
    case "page.waitForSelector": {
      const timeout = payload.waitTimeoutMs ?? 10_000;
      assertInteger(timeout, "payload.waitTimeoutMs", 100);
      if (timeout > 20_000) {
        throw new ValidationError("payload.waitTimeoutMs must be <= 20000");
      }
      break;
    }
    case "page.scroll":
      if (payload.deltaY !== undefined && !Number.isFinite(payload.deltaY)) {
        throw new ValidationError("payload.deltaY must be a number");
      }
      break;
  }

  return {
    deviceId,
    action: input.action,
    payload,
    timeoutMs
  };
}
