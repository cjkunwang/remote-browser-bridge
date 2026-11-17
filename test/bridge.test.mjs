import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createBridgeServer } from "../server/bridge.mjs";

const TOKEN = "integration-test-token-48b355be71f8";

test("extension pairs, is listed, and executes a correlated command", async (t) => {
  const bridge = createBridgeServer({ token: TOKEN, logger: { info() {}, error() {} } });
  const address = await bridge.start({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => bridge.close());

  const unauthorized = await fetch(`${baseUrl}/api/devices`);
  assert.equal(unauthorized.status, 401);

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const readyPromise = onceMessage(socket, (message) => message.type === "ready");
  socket.send(JSON.stringify({
    type: "hello",
    token: TOKEN,
    deviceId: "chrome_integration_123456",
    name: "Integration Chrome",
    version: "0.1.0",
    capabilities: ["tab.open", "tab.close"]
  }));
  const ready = await readyPromise;
  assert.equal(ready.deviceId, "chrome_integration_123456");

  socket.send(JSON.stringify({
    type: "session-state",
    session: {
      id: "session-1",
      scope: "origin",
      origin: "https://example.com",
      tabId: null,
      capabilities: ["tabs.control", "page.read"],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      idleExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      lastUsedAt: new Date().toISOString()
    },
    pendingSessionRequest: null
  }));

  let devicesBody;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const devicesResponse = await fetch(`${baseUrl}/api/devices`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(devicesResponse.status, 200);
    devicesBody = await devicesResponse.json();
    if (devicesBody.devices[0]?.session) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(devicesBody.devices.length, 1);
  assert.equal(devicesBody.devices[0].name, "Integration Chrome");
  assert.equal(devicesBody.devices[0].session.origin, "https://example.com");

  const commandPromise = onceMessage(socket, (message) => message.type === "command");
  const httpCommand = fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      deviceId: "chrome_integration_123456",
      action: "tab.open",
      payload: { url: "https://example.com" },
      timeoutMs: 5_000
    })
  });

  const command = await commandPromise;
  assert.equal(command.action, "tab.open");
  assert.equal(command.payload.url, "https://example.com");
  socket.send(JSON.stringify({
    type: "response",
    id: command.id,
    ok: true,
    result: { tab: { id: 42, url: "https://example.com" } }
  }));

  const commandResponse = await httpCommand;
  assert.equal(commandResponse.status, 200);
  const commandBody = await commandResponse.json();
  assert.deepEqual(commandBody.result, { tab: { id: 42, url: "https://example.com" } });
  socket.close();
});

test("a disconnected device produces a useful API failure", async (t) => {
  const bridge = createBridgeServer({ token: TOKEN, logger: { info() {}, error() {} } });
  const address = await bridge.start({ host: "127.0.0.1", port: 0 });
  t.after(() => bridge.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/api/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      deviceId: "chrome_missing_123456",
      action: "tab.list",
      payload: {}
    })
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "device_not_connected");
});

test("browser session authorization errors preserve status and request details", async (t) => {
  const bridge = createBridgeServer({ token: TOKEN, logger: { info() {}, error() {} } });
  const address = await bridge.start({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => bridge.close());

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const readyPromise = onceMessage(socket, (message) => message.type === "ready");
  socket.send(JSON.stringify({
    type: "hello",
    token: TOKEN,
    deviceId: "chrome_session_123456",
    name: "Session Chrome",
    version: "0.1.0",
    capabilities: ["tab.open"]
  }));
  await readyPromise;

  const commandPromise = onceMessage(socket, (message) => message.type === "command");
  const httpCommand = fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      deviceId: "chrome_session_123456",
      action: "tab.open",
      payload: { url: "https://example.com" }
    })
  });
  const command = await commandPromise;
  socket.send(JSON.stringify({
    type: "response",
    id: command.id,
    ok: false,
    code: "session_required",
    error: "browser-local session required",
    details: { request: { id: "request-1", action: "tab.open", origin: "https://example.com" } }
  }));

  const response = await httpCommand;
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "session_required");
  assert.equal(body.details.request.origin, "https://example.com");
  socket.close();
});

function onceMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("message timeout"));
    }, 3_000);

    function onMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    }

    socket.on("message", onMessage);
  });
}
