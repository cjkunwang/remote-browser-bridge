import { grantOptionsFromMessage } from "./session-message.js";

const DEFAULT_SERVER_URL = "ws://127.0.0.1:8787/ws";
const RECONNECT_ALARM = "remote-browser-bridge-reconnect";
const SESSION_EXPIRE_ALARM = "remote-browser-bridge-session-expire";
const ACTIONS = new Set([
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

const SESSION_CAPABILITIES = Object.freeze([
  "tabs.control",
  "page.read",
  "page.control",
  "screenshot",
  "monitor.events"
]);
const SESSION_MAX_MS = 120 * 60 * 1000;
const SESSION_IDLE_MS = 5 * 60 * 1000;

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let manualDisconnect = false;
let connectPromise = null;

void initialize();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    "serverUrl",
    "token",
    "deviceId",
    "deviceName",
    "autoConnect",
    "connectionPaused"
  ]);
  await chrome.storage.local.set({
    serverUrl: existing.serverUrl || DEFAULT_SERVER_URL,
    token: existing.token || "",
    deviceId: existing.deviceId || randomDeviceId(),
    deviceName: existing.deviceName || "My Chrome",
    autoConnect: existing.autoConnect !== false,
    connectionPaused: false
  });
  void connect();
});

chrome.runtime.onStartup.addListener(async () => {
  const { autoConnect } = await chrome.storage.local.get("autoConnect");
  if (autoConnect !== false) await chrome.storage.local.set({ connectionPaused: false });
  void initialize();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connect();
  if (alarm.name === SESSION_EXPIRE_ALARM) void getActiveSession().then(updateSessionBadge);
});
chrome.tabs.onCreated.addListener((tab) => void emitTabEvent("created", tab));
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void emitTabEvent("removed", { id: tabId, ...removeInfo });
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void emitTabEvent("activated", { id: tabId, windowId });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status || changeInfo.url || changeInfo.title) {
    void emitTabEvent("updated", tab);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "connection") {
    if (message.action === "connect") {
      manualDisconnect = false;
      void (async () => {
        try {
          await chrome.storage.local.set({ connectionPaused: false });
          sendResponse(await connect());
        } catch (error) {
          const state = { phase: "error", message: errorMessage(error) };
          await setState(state.phase, state.message);
          sendResponse(state);
        }
      })();
    } else if (message.action === "disconnect") {
      manualDisconnect = true;
      clearReconnect();
      closeSocket();
      void (async () => {
        try {
          await chrome.storage.local.set({ connectionPaused: true });
          await setState("disconnected", "Disconnected by user");
          sendResponse(await getState());
        } catch (error) {
          sendResponse({ phase: "error", message: errorMessage(error) });
        }
      })();
    } else {
      void getState().then(sendResponse);
    }
    return true;
  }

  if (message.type === "status") {
    void getState().then(sendResponse);
    return true;
  }

  if (message.type === "session") {
    void (async () => {
      try {
        if (message.action === "grant") {
          sendResponse(await grantSession(grantOptionsFromMessage(message)));
        } else if (message.action === "revoke") {
          sendResponse(await revokeSession("revoked by user"));
        } else if (message.action === "deny") {
          sendResponse(await denyPendingSession());
        } else {
          sendResponse(await getSessionState());
        }
      } catch (error) {
        sendResponse({ error: errorMessage(error) });
      }
    })();
    return true;
  }

  return false;
});

async function initialize() {
  const stored = await chrome.storage.local.get([
    "serverUrl",
    "token",
    "deviceId",
    "deviceName",
    "autoConnect",
    "connectionPaused"
  ]);
  const defaults = {
    serverUrl: stored.serverUrl || DEFAULT_SERVER_URL,
    token: stored.token || "",
    deviceId: stored.deviceId || randomDeviceId(),
    deviceName: stored.deviceName || "My Chrome",
    autoConnect: stored.autoConnect !== false,
    connectionPaused: stored.connectionPaused === true
  };
  await chrome.storage.local.set(defaults);
  await updateSessionBadge();
  if (defaults.autoConnect && defaults.token && !defaults.connectionPaused) await connect();
}

async function connect() {
  if (connectPromise) return connectPromise;
  connectPromise = connectInternal().finally(() => {
    connectPromise = null;
  });
  return connectPromise;
}

async function connectInternal() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return getState();
  }

  const { serverUrl, token, deviceId, deviceName, connectionPaused } = await chrome.storage.local.get([
    "serverUrl",
    "token",
    "deviceId",
    "deviceName",
    "connectionPaused"
  ]);

  if (connectionPaused) {
    await setState("disconnected", "Connection is paused");
    return getState();
  }

  if (!token) {
    await setState("needs_pairing", "Enter the server pairing token");
    return getState();
  }

  let parsed;
  try {
    parsed = new URL(serverUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error();
  } catch {
    await setState("error", "Server URL must use ws:// or wss://");
    return getState();
  }

  await setState("connecting", `Connecting to ${parsed.origin}`);
  const currentSocket = new WebSocket(parsed.toString());
  socket = currentSocket;

  currentSocket.addEventListener("open", async () => {
    if (socket !== currentSocket) return;
    reconnectAttempt = 0;
    await clearReconnect();
    currentSocket.send(JSON.stringify({
      type: "hello",
      token,
      deviceId,
      name: deviceName || "My Chrome",
      version: chrome.runtime.getManifest().version,
      capabilities: [...ACTIONS]
    }));
    await setState("connecting", "WebSocket connected; authenticating");
  });

  currentSocket.addEventListener("message", (event) => {
    void handleSocketMessage(currentSocket, event.data);
  });

  currentSocket.addEventListener("close", (event) => {
    if (socket === currentSocket) socket = null;
    if (event.code === 1008 || event.code === 4000) {
      void setState("error", event.reason || "Connection rejected");
    } else {
      void setState("disconnected", event.reason || "Connection closed");
      scheduleReconnect();
    }
  });

  currentSocket.addEventListener("error", () => {
    if (socket === currentSocket) {
      void setState("error", "WebSocket connection failed");
    }
  });

  return getState();
}

async function handleSocketMessage(currentSocket, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "ready") {
    await setState("ready", "Authenticated and ready");
    await syncSessionState();
    return;
  }

  if (message.type !== "command" || typeof message.id !== "string") return;
  try {
    const result = await executeCommand(message.action, message.payload, message.timeoutMs);
    currentSocket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
  } catch (error) {
    const details = error?.details || null;
    currentSocket.send(JSON.stringify({
      type: "response",
      id: message.id,
      ok: false,
      error: errorMessage(error),
      ...(error?.code ? { code: error.code } : {}),
      ...(details ? { details } : {})
    }));
  }
}

async function executeCommand(action, payload = {}, timeoutMs = 15_000) {
  if (!ACTIONS.has(action)) throw new Error(`Unsupported action: ${action}`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be an object");
  }

  if (action === "session.status") return getSessionState();

  const session = action === "tab.list" ? await getActiveSession() : await authorizeAction(action, payload);
  const wrapped = Promise.race([
    dispatchCommand(action, payload, session),
    new Promise((_, reject) => setTimeout(() => reject(new Error("browser command timed out")), timeoutMs))
  ]);
  const result = await wrapped;
  if (session) await touchSession(session);
  return result;
}

async function dispatchCommand(action, payload, session) {
  switch (action) {
    case "tab.list": {
      const tabs = await chrome.tabs.query({});
      const httpTabs = tabs.filter(isHttpTab);
      if (!session) {
        return {
          tabs: [],
          tabCount: httpTabs.length,
          sessionRequired: true,
          message: "Full tab metadata requires a browser-local session"
        };
      }
      const visibleTabs = httpTabs.filter((tab) => sessionAllowsTab(session, tab));
      return {
        tabs: visibleTabs.map(normalizeTab),
        tabCount: httpTabs.length,
        session: sessionSummary(session)
      };
    }
    case "tab.open": {
      const tab = await chrome.tabs.create({ url: safeHttpUrl(payload.url), active: payload.active !== false });
      return { tab: normalizeTab(tab) };
    }
    case "tab.navigate": {
      const tabId = requiredTabId(payload);
      assertHttpTab(await chrome.tabs.get(tabId));
      const tab = await chrome.tabs.update(tabId, { url: safeHttpUrl(payload.url) });
      return { tab: normalizeTab(tab) };
    }
    case "tab.close": {
      const tabId = requiredTabId(payload);
      assertHttpTab(await chrome.tabs.get(tabId));
      await chrome.tabs.remove(tabId);
      return { closedTabId: tabId };
    }
    case "tab.activate": {
      const tabId = requiredTabId(payload);
      assertHttpTab(await chrome.tabs.get(tabId));
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { tab: normalizeTab(tab) };
    }
    case "tab.screenshot":
      return { dataUrl: await captureTab(payload) };
    case "window.open": {
      const created = await chrome.windows.create({
        url: safeHttpUrl(payload.url),
        focused: payload.focused !== false,
        type: "normal"
      });
      return { windowId: created.id, tabs: (created.tabs || []).map(normalizeTab) };
    }
    case "window.close": {
      const windowId = requiredPositiveInteger(payload.windowId, "windowId");
      await chrome.windows.remove(windowId);
      return { closedWindowId: windowId };
    }
    case "page.click":
      return executeInPage(payload, clickElement);
    case "page.type":
      return executeInPage(payload, typeIntoElement, [payload.selector, payload.text, payload.submit === true]);
    case "page.text":
      return executeInPage(payload, readElementText);
    case "page.waitForSelector":
      return waitForSelectorInPage(payload);
    case "page.scroll":
      return executeInPage(payload, scrollPage, [Number(payload.deltaY) || 0]);
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

class BrowserAuthorizationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "BrowserAuthorizationError";
    this.code = "session_required";
    this.details = details;
  }
}

async function authorizeAction(action, payload) {
  const session = await getActiveSession();
  const target = await resolveCommandTarget(action, payload);
  const capability = capabilityForAction(action);

  if (session && sessionAllows(session, target, capability)) return session;

  const request = await recordSessionRequest(action, target);
  const reason = action === "tab.list"
    ? "需要授权查看完整标签页"
    : `需要浏览器本地授权：${target.origin || "当前浏览器"}`;
  throw new BrowserAuthorizationError(reason, { request });
}

async function resolveCommandTarget(action, payload) {
  if (action === "tab.open" || action === "window.open") {
    const url = safeHttpUrl(payload.url);
    return { origin: new URL(url).origin, tabId: null, url, opener: true };
  }

  if (action === "window.close") {
    return { origin: null, tabId: null, url: null, windowId: requiredPositiveInteger(payload.windowId, "windowId") };
  }

  if (action === "tab.navigate") {
    const tab = await getTargetTab(payload);
    const url = safeHttpUrl(payload.url);
    return { origin: new URL(url).origin, tabId: tab.id, url, tab };
  }

  const tab = await getTargetTab(payload);
  assertHttpTab(tab);
  const url = tab.url || tab.pendingUrl || "";
  return { origin: new URL(url).origin, tabId: tab.id, url, tab };
}

function sessionAllows(session, target, capability) {
  if (!session || !session.capabilities.includes(capability)) return false;
  if (session.scope === "all") return true;
  if (!target.origin || target.origin !== session.origin) return false;
  if (session.scope === "page") {
    return !target.opener && target.tabId === session.tabId;
  }
  return true;
}

function sessionAllowsTab(session, tab) {
  const url = tab.url || tab.pendingUrl || "";
  try {
    const origin = new URL(url).origin;
    if (session.scope === "page") return tab.id === session.tabId;
    return session.scope === "all" || origin === session.origin;
  } catch {
    return false;
  }
}

function capabilityForAction(action) {
  if (["tab.open", "tab.navigate", "tab.close", "tab.activate", "window.open", "window.close"].includes(action)) {
    return "tabs.control";
  }
  if (action === "tab.screenshot") return "screenshot";
  if (action === "page.text" || action === "page.waitForSelector") return "page.read";
  return "page.control";
}

async function getActiveSession() {
  const { remoteSession } = await chrome.storage.local.get("remoteSession");
  if (!remoteSession) return null;
  const now = Date.now();
  if (Date.parse(remoteSession.expiresAt) <= now || Date.parse(remoteSession.idleExpiresAt) <= now) {
    await revokeSession("session expired");
    return null;
  }
  return remoteSession;
}

async function grantSession({ scope = "origin", durationMinutes = 30, origin = null, tabId = null } = {}) {
  if (!["page", "origin", "all"].includes(scope)) throw new Error("Invalid session scope");
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0] || null;

  let sessionOrigin = safeOrigin(origin);
  let sessionTabId = null;
  if (scope === "page") {
    const requestedTab = Number.isInteger(tabId) && tabId > 0
      ? await chrome.tabs.get(tabId).catch(() => null)
      : tab;
    if (!requestedTab || !isHttpTab(requestedTab)) throw new Error("授权页面已失效");
    sessionOrigin = sessionOrigin || new URL(requestedTab.url || requestedTab.pendingUrl).origin;
    sessionTabId = requestedTab.id;
  }
  if (!sessionOrigin && tab && isHttpTab(tab)) {
    sessionOrigin = new URL(tab.url || tab.pendingUrl).origin;
  }
  if (scope !== "all" && !sessionOrigin) throw new Error("当前标签页不是 HTTP(S) 页面");

  const now = Date.now();
  const durationMs = Math.min(
    SESSION_MAX_MS,
    Math.max(60_000, Number(durationMinutes || 30) * 60_000)
  );
  const session = {
    id: crypto.randomUUID(),
    scope,
    origin: sessionOrigin,
    tabId: sessionTabId,
    capabilities: [...SESSION_CAPABILITIES],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMs).toISOString(),
    idleExpiresAt: new Date(now + SESSION_IDLE_MS).toISOString(),
    lastUsedAt: new Date(now).toISOString()
  };

  await chrome.storage.local.set({ remoteSession: session, pendingSessionRequest: null });
  await scheduleSessionExpiry(session);
  await updateSessionBadge();
  await syncSessionState();
  return getSessionState();
}

async function revokeSession(reason = "session revoked") {
  await chrome.storage.local.remove("remoteSession");
  await chrome.alarms.clear(SESSION_EXPIRE_ALARM).catch(() => {});
  await updateSessionBadge();
  await syncSessionState(reason);
  return getSessionState();
}

async function denyPendingSession() {
  await chrome.storage.local.remove("pendingSessionRequest");
  await updateSessionBadge();
  await syncSessionState("session request denied");
  return getSessionState();
}

async function recordSessionRequest(action, target) {
  const request = {
    id: crypto.randomUUID(),
    action,
    reason: `Remote action requested: ${action}`,
    origin: target.origin,
    tabId: target.tabId,
    requestedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ pendingSessionRequest: request });
  await updateSessionBadge();
  await syncSessionState();
  return request;
}

async function touchSession(session) {
  const now = Date.now();
  const current = await getActiveSession();
  if (!current || current.id !== session.id) return;
  current.lastUsedAt = new Date(now).toISOString();
  current.idleExpiresAt = new Date(Math.min(Date.parse(current.expiresAt), now + SESSION_IDLE_MS)).toISOString();
  await chrome.storage.local.set({ remoteSession: current });
  await scheduleSessionExpiry(current);
  await syncSessionState();
}

async function getSessionState() {
  const { remoteSession, pendingSessionRequest } = await chrome.storage.local.get([
    "remoteSession",
    "pendingSessionRequest"
  ]);
  const session = remoteSession
    ? { ...sessionSummary(remoteSession), active: Date.now() < Date.parse(remoteSession.expiresAt) }
    : null;
  return { session, pendingSessionRequest: pendingSessionRequest || null };
}

function sessionSummary(session) {
  return {
    id: session.id,
    scope: session.scope,
    origin: session.origin,
    tabId: session.tabId,
    capabilities: session.capabilities,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    idleExpiresAt: session.idleExpiresAt,
    lastUsedAt: session.lastUsedAt
  };
}

async function syncSessionState(reason = null) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const { remoteSession, pendingSessionRequest } = await chrome.storage.local.get([
    "remoteSession",
    "pendingSessionRequest"
  ]);
  socket.send(JSON.stringify({
    type: "session-state",
    session: remoteSession ? sessionSummary(remoteSession) : null,
    pendingSessionRequest: pendingSessionRequest || null,
    reason
  }));
}

async function updateSessionBadge() {
  const { remoteSession, pendingSessionRequest } = await chrome.storage.local.get([
    "remoteSession",
    "pendingSessionRequest"
  ]);
  if (remoteSession && Date.now() < Date.parse(remoteSession.expiresAt)) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0b7a4b" }).catch(() => {});
    await chrome.action.setBadgeText({ text: "ON" }).catch(() => {});
  } else if (pendingSessionRequest) {
    await chrome.action.setBadgeBackgroundColor({ color: "#d97706" }).catch(() => {});
    await chrome.action.setBadgeText({ text: "!" }).catch(() => {});
  } else {
    await chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }
}

async function scheduleSessionExpiry(session) {
  const expiresAt = Math.min(Date.parse(session.expiresAt), Date.parse(session.idleExpiresAt));
  await chrome.alarms.create(SESSION_EXPIRE_ALARM, { when: expiresAt }).catch(() => {});
}

async function emitTabEvent(event, tab) {
  const session = await getActiveSession();
  if (!session || !session.capabilities.includes("monitor.events")) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const data = tab?.url ? normalizeTab(tab) : {
    id: tab?.id ?? null,
    windowId: tab?.windowId ?? null,
    isWindowClosing: Boolean(tab?.isWindowClosing)
  };
  socket.send(JSON.stringify({
    type: "event",
    event: `tab.${event}`,
    at: new Date().toISOString(),
    data
  }));
}

async function executeInPage(payload, func, args) {
  const targetTab = await getTargetTab(payload);
  const tab = await waitForHttpTab(targetTab);
  if (!/^https?:/i.test(tab.url || "")) {
    throw new Error("Page automation only supports http(s) tabs");
  }
  const injectionArgs = args || [payload.selector];
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args: injectionArgs
  });
  return results[0]?.result ?? null;
}

async function waitForSelectorInPage(payload, defaultTimeoutMs = 10_000) {
  const targetTab = await getTargetTab(payload);
  const tab = await waitForHttpTab(targetTab);
  const deadline = Date.now() + (payload.waitTimeoutMs || defaultTimeoutMs);

  while (Date.now() < deadline) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: inspectSelector,
      args: [payload.selector]
    });
    const snapshot = results[0]?.result;
    if (snapshot?.found) return snapshot;
    await delay(100);
  }

  throw new Error(`Timed out waiting for selector: ${payload.selector}`);
}

async function getTargetTab(payload) {
  if (payload.tabId !== undefined) {
    return chrome.tabs.get(requiredTabId(payload));
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs[0]) throw new Error("No active tab found; provide payload.tabId");
  return tabs[0];
}

async function waitForHttpTab(tab, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let current = tab;
  while (Date.now() < deadline) {
    current = await chrome.tabs.get(tab.id);
    if (/^https?:/i.test(current.url || current.pendingUrl || "") && current.status !== "loading") {
      return current;
    }
    await delay(100);
  }
  return current;
}

async function captureTab(payload) {
  const tab = await getTargetTab(payload);
  assertHttpTab(tab, "Screenshots only support http(s) tabs");
  let previousTabId = null;
  if (!tab.active) {
    const activeTabs = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    previousTabId = activeTabs[0]?.id ?? null;
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await delay(200);
  }

  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } finally {
    if (previousTabId) await chrome.tabs.update(previousTabId, { active: true }).catch(() => {});
  }
}

function normalizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    incognito: Boolean(tab.incognito),
    status: tab.status || "unknown",
    title: tab.title || "",
    url: tab.url || tab.pendingUrl || ""
  };
}

function isHttpTab(tab) {
  return /^https?:/i.test(tab.url || tab.pendingUrl || "");
}

function assertHttpTab(tab, message = "Browser actions only support http(s) tabs") {
  if (!isHttpTab(tab)) throw new Error(message);
  return tab;
}

function clickElement(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (element instanceof HTMLElement) element.focus({ preventScroll: true });
  element.click();
  return {
    selector,
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 500)
  };
}

function typeIntoElement(selector, text, submit) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);

  const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
  if (
    element instanceof HTMLInputElement &&
    (element.type === "password" || autocomplete.includes("password"))
  ) {
    throw new Error("Typing into password fields is blocked");
  }

  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (element instanceof HTMLElement) element.focus({ preventScroll: true });

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("Unable to set field value");
    setter.call(element, text);
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (element.isContentEditable) {
    element.textContent = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  } else {
    throw new Error("Target is not a writable input, textarea, or contenteditable element");
  }

  if (submit && element instanceof HTMLInputElement && element.form) {
    element.form.requestSubmit();
  }
  return { selector, chars: text.length, submitted: Boolean(submit) };
}

function readElementText(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return {
    selector,
    text: (element.innerText ?? element.textContent ?? "").trim().slice(0, 20_000)
  };
}

function inspectSelector(selector) {
  const element = document.querySelector(selector);
  if (!element) return { selector, found: false };
  return {
    selector,
    found: true,
    text: (element.innerText || element.textContent || "").trim().slice(0, 2_000)
  };
}

function scrollPage(deltaY) {
  window.scrollBy({ top: deltaY || 0, behavior: "instant" });
  return { scrollX: window.scrollX, scrollY: window.scrollY };
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new Error("URL must use http:// or https://");
  }
}

function safeOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function requiredTabId(payload) {
  return requiredPositiveInteger(payload.tabId, "tabId");
}

function requiredPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function randomDeviceId() {
  return `chrome_${crypto.randomUUID().replaceAll("-", "")}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setState(phase, message) {
  await chrome.storage.local.set({
    connectionState: {
      phase,
      message,
      updatedAt: new Date().toISOString()
    }
  });
  void chrome.action.setTitle({ title: `Remote Browser Bridge — ${message}` }).catch(() => {});
}

async function getState() {
  const { connectionState } = await chrome.storage.local.get("connectionState");
  return connectionState || { phase: "idle", message: "Not connected" };
}

function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer) return;
  reconnectAttempt += 1;
  const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
  void chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 }).catch(() => {});
}

async function clearReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  await chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
}

function closeSocket() {
  if (!socket) return;
  const current = socket;
  socket = null;
  current.close(1000, "disconnected by user");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
