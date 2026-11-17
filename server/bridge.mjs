import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  sanitizeDeviceId,
  safeTokenEqual,
  validateCommand,
  ValidationError
} from "./protocol.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(moduleDir, "public");
const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }]
]);

class BridgeCommandError extends Error {
  constructor(code, message, details = null, status = 502) {
    super(message);
    this.name = "BridgeCommandError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export function createBridgeServer({ token, logger = console }) {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("A bridge token with at least 16 characters is required");
  }

  const devices = new Map();
  const pendingCommands = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          ok: true,
          service: "remote-browser-bridge",
          devices: devices.size,
          time: new Date().toISOString()
        });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!authorized(request, token)) {
          sendJson(response, 401, { ok: false, error: "unauthorized" });
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/devices") {
          sendJson(response, 200, { ok: true, devices: listDevices(devices) });
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/commands") {
          const body = await readJsonBody(request);
          const command = validateCommand(body);
          const result = await sendCommand(command);
          sendJson(response, 200, { ok: true, result });
          return;
        }

        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "method_not_allowed" });
        return;
      }

      const asset = STATIC_FILES.get(url.pathname);
      if (!asset) {
        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }

      const content = await readFile(path.join(publicDir, asset.file));
      response.writeHead(200, {
        "Content-Type": asset.type,
        "Content-Length": content.length,
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      });
      if (request.method === "HEAD") response.end();
      else response.end(content);
    } catch (error) {
      const status = error instanceof ValidationError
        ? 400
        : error instanceof BridgeCommandError
          ? error.status
          : 500;
      if (status >= 500 && !(error instanceof BridgeCommandError)) {
        logger.error?.("[bridge] request failed", error);
      }
      sendJson(response, status, {
        ok: false,
        error: error instanceof ValidationError || error instanceof BridgeCommandError
          ? error.message
          : "internal_error",
        ...(error instanceof BridgeCommandError ? {
          code: error.code,
          ...(error.details ? { details: error.details } : {})
        } : {})
      });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    let authenticated = false;
    let deviceId = null;
    let heartbeat = null;
    const authTimer = setTimeout(() => {
      if (!authenticated) ws.close(1008, "hello timeout");
    }, 5_000);

    ws.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        ws.close(1003, "invalid JSON");
        return;
      }

      if (!authenticated) {
        if (message.type !== "hello" || !safeTokenEqual(message.token, token)) {
          ws.close(1008, "unauthorized");
          return;
        }

        const requestedId = sanitizeDeviceId(message.deviceId);
        if (!requestedId) {
          ws.close(1008, "invalid deviceId");
          return;
        }

        authenticated = true;
        deviceId = requestedId;
        clearTimeout(authTimer);
        registerDevice({ ws, deviceId, hello: message, request });
        ws.send(JSON.stringify({
          type: "ready",
          deviceId,
          serverTime: new Date().toISOString()
        }));
        logger.info?.(`[bridge] device connected: ${deviceId}`);
        heartbeat = setInterval(() => {
          if (ws.isAlive === false) {
            ws.terminate();
            return;
          }
          ws.isAlive = false;
          ws.ping();
        }, 30_000);
        return;
      }

      if (message.type === "response") {
        settlePendingCommand(deviceId, ws, message);
        return;
      }

      if (message.type === "session-state") {
        const device = devices.get(deviceId);
        if (device?.ws === ws) {
          device.session = sanitizeRemoteSession(message.session);
          device.pendingSessionRequest = sanitizePendingSessionRequest(message.pendingSessionRequest);
        }
        return;
      }

      if (message.type === "event") {
        const device = devices.get(deviceId);
        if (device?.ws === ws) {
          device.events.push(sanitizeBrowserEvent(message));
          device.events = device.events.slice(-100);
          device.lastEventAt = new Date().toISOString();
        }
        return;
      }

      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
      }
    });

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (deviceId) {
        const current = devices.get(deviceId);
        if (current?.ws === ws) devices.delete(deviceId);
        rejectPendingForDevice(deviceId, "device disconnected");
        logger.info?.(`[bridge] device disconnected: ${deviceId}`);
      }
    });
  });

  function registerDevice({ ws, deviceId: id, hello }) {
    const existing = devices.get(id);
    if (existing && existing.ws !== ws) {
      existing.ws.close(4000, "replaced by a new connection");
    }
    devices.set(id, {
      id,
      name: cleanLabel(hello.name, "Chrome"),
      version: cleanLabel(hello.version, "unknown"),
      capabilities: Array.isArray(hello.capabilities)
        ? hello.capabilities.filter((item) => typeof item === "string").slice(0, 30)
        : [],
      connectedAt: new Date().toISOString(),
      session: null,
      pendingSessionRequest: null,
      events: [],
      lastEventAt: null,
      ws
    });
  }

  function settlePendingCommand(id, socket, message) {
    if (typeof message.id !== "string") return;
    const pending = pendingCommands.get(message.id);
    if (!pending || pending.deviceId !== id || pending.socket !== socket) return;

    pendingCommands.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result ?? null);
    else pending.reject(new BridgeCommandError(
      typeof message.code === "string" ? message.code : "browser_command_failed",
      message.error || "browser command failed",
      message.details ?? null,
      message.code === "session_required" ? 403 : 502
    ));
  }

  function rejectPendingForDevice(id, reason) {
    for (const [commandId, pending] of pendingCommands) {
      if (pending.deviceId !== id) continue;
      pendingCommands.delete(commandId);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  function sendCommand(input) {
    const command = validateCommand(input);
    const device = devices.get(command.deviceId);
    if (!device || device.ws.readyState !== WebSocket.OPEN) {
      throw new BridgeCommandError("device_not_connected", "device is not connected", null, 503);
    }

    const commandId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(commandId);
        reject(new Error(`browser command timed out after ${command.timeoutMs}ms`));
      }, command.timeoutMs);

      pendingCommands.set(commandId, {
        deviceId: command.deviceId,
        socket: device.ws,
        resolve,
        reject,
        timer
      });

      try {
        device.ws.send(JSON.stringify({
          type: "command",
          id: commandId,
          action: command.action,
          payload: command.payload,
          timeoutMs: command.timeoutMs
        }));
      } catch (error) {
        clearTimeout(timer);
        pendingCommands.delete(commandId);
        reject(error);
      }
    });
  }

  async function start({ host = "127.0.0.1", port = 8787 } = {}) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server.address();
  }

  async function close() {
    rejectPendingForDeviceAll("server stopped");
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => resolve()));
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  }

  function rejectPendingForDeviceAll(reason) {
    for (const [commandId, pending] of pendingCommands) {
      pendingCommands.delete(commandId);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  return { server, wss, devices, start, close, sendCommand };
}

function listDevices(devices) {
  return [...devices.values()].map(({ ws: _ws, ...device }) => device);
}

function cleanLabel(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().slice(0, 100);
  return normalized || fallback;
}

function sanitizeRemoteSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scopes = new Set(["page", "origin", "all"]);
  const timestamps = ["createdAt", "expiresAt", "idleExpiresAt", "lastUsedAt"];
  return {
    id: cleanLabel(value.id, "unknown"),
    scope: scopes.has(value.scope) ? value.scope : "origin",
    origin: sanitizeOrigin(value.origin),
    tabId: Number.isInteger(value.tabId) && value.tabId > 0 ? value.tabId : null,
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.filter((item) => typeof item === "string").slice(0, 30)
      : [],
    ...Object.fromEntries(timestamps.map((key) => [
      key,
      Number.isFinite(Date.parse(value[key])) ? new Date(value[key]).toISOString() : null
    ])),
    active: value.active !== false
  };
}

function sanitizePendingSessionRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    id: cleanLabel(value.id, "unknown"),
    action: cleanLabel(value.action, "unknown"),
    reason: cleanLabel(value.reason, "Remote browser access requested"),
    origin: sanitizeOrigin(value.origin),
    tabId: Number.isInteger(value.tabId) && value.tabId > 0 ? value.tabId : null,
    requestedAt: Number.isFinite(Date.parse(value.requestedAt))
      ? new Date(value.requestedAt).toISOString()
      : null
  };
}

function sanitizeBrowserEvent(value) {
  const eventTypes = new Set(["tab.created", "tab.removed", "tab.updated", "tab.activated"]);
  const event = eventTypes.has(value.event) ? value.event : "browser.event";
  const data = value.data && typeof value.data === "object" && !Array.isArray(value.data)
    ? value.data
    : {};
  return {
    event,
    at: Number.isFinite(Date.parse(value.at)) ? new Date(value.at).toISOString() : new Date().toISOString(),
    data: {
      id: Number.isInteger(data.id) ? data.id : null,
      windowId: Number.isInteger(data.windowId) ? data.windowId : null,
      title: typeof data.title === "string" ? data.title.slice(0, 500) : "",
      url: typeof data.url === "string" ? data.url.slice(0, 4096) : "",
      active: Boolean(data.active),
      status: typeof data.status === "string" ? data.status : "unknown"
    }
  };
}

function sanitizeOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function authorized(request, token) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return safeTokenEqual(header.slice("Bearer ".length), token);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new ValidationError("request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ValidationError("request body must be JSON");
  }
}

function sendJson(response, status, body) {
  const content = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(content);
}
