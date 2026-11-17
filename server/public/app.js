const SESSION_TOKEN_KEY = "remote-browser-bridge-token";
const SAMPLE_PAYLOADS = {
  "session.status": {},
  "tab.list": {},
  "tab.open": { url: "https://example.com", active: true },
  "tab.navigate": { tabId: 123, url: "https://example.com" },
  "tab.close": { tabId: 123 },
  "tab.activate": { tabId: 123 },
  "tab.screenshot": { tabId: 123 },
  "window.open": { url: "https://example.com" },
  "window.close": { windowId: 456 },
  "page.click": { tabId: 123, selector: "button[type=submit]" },
  "page.type": { tabId: 123, selector: "input[name=q]", text: "hello" },
  "page.text": { tabId: 123, selector: "main" },
  "page.waitForSelector": { tabId: 123, selector: ".result", waitTimeoutMs: 10000 },
  "page.scroll": { tabId: 123, deltaY: 600 }
};

const state = {
  token: sessionStorage.getItem(SESSION_TOKEN_KEY) || "",
  devices: [],
  selectedDeviceId: "",
  refreshTimer: null
};

const elements = {
  serverStatus: document.querySelector("#serverStatus"),
  authPanel: document.querySelector("#authPanel"),
  authForm: document.querySelector("#authForm"),
  token: document.querySelector("#token"),
  workspace: document.querySelector("#workspace"),
  devices: document.querySelector("#devices"),
  refreshDevices: document.querySelector("#refreshDevices"),
  logout: document.querySelector("#logout"),
  targetDevice: document.querySelector("#targetDevice"),
  commandForm: document.querySelector("#commandForm"),
  action: document.querySelector("#action"),
  payload: document.querySelector("#payload"),
  runCommand: document.querySelector("#runCommand"),
  output: document.querySelector("#output"),
  clearOutput: document.querySelector("#clearOutput")
};

void boot();

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = elements.token.value.trim();
  if (!state.token) return;
  sessionStorage.setItem(SESSION_TOKEN_KEY, state.token);
  await authenticate();
});

elements.refreshDevices.addEventListener("click", () => void loadDevices());
elements.logout.addEventListener("click", logout);
elements.clearOutput.addEventListener("click", () => {
  elements.output.replaceChildren();
  appendEmpty("等待执行命令。");
});

elements.action.addEventListener("change", () => {
  const sample = SAMPLE_PAYLOADS[elements.action.value] || {};
  elements.payload.value = JSON.stringify(sample, null, 2);
});

elements.commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await executeCommand(elements.action.value);
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.action.value = button.dataset.action;
    elements.action.dispatchEvent(new Event("change"));
    elements.payload.focus();
  });
});

async function boot() {
  elements.token.value = state.token;
  if (!state.token) return;
  await authenticate();
}

async function authenticate() {
  try {
    await api("/api/devices");
    elements.authPanel.classList.add("hidden");
    elements.workspace.classList.remove("hidden");
    setServerStatus("服务已认证", "ok");
    await loadDevices();
    startRefresh();
  } catch (error) {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    state.token = "";
    elements.authPanel.classList.remove("hidden");
    elements.workspace.classList.add("hidden");
    setServerStatus(error.message === "unauthorized" ? "Token 不正确" : "服务不可用", "error");
  }
}

async function loadDevices() {
  try {
    const data = await api("/api/devices");
    state.devices = data.devices || [];
    if (!state.devices.some((device) => device.id === state.selectedDeviceId)) {
      state.selectedDeviceId = state.devices[0]?.id || "";
    }
    renderDevices();
    setServerStatus(`服务已认证 · ${state.devices.length} 台设备`, "ok");
  } catch (error) {
    setServerStatus(error.message || "刷新失败", "error");
  }
}

function renderDevices() {
  elements.devices.replaceChildren();
  if (state.devices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "device-empty";
    empty.textContent = "还没有浏览器连接。安装扩展并填写同一 Token。";
    elements.devices.append(empty);
    elements.targetDevice.textContent = "未连接浏览器";
    return;
  }

  for (const device of state.devices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `device${device.id === state.selectedDeviceId ? " selected" : ""}`;
    const name = document.createElement("strong");
    name.textContent = device.name;
    const meta = document.createElement("small");
    const sessionText = device.session ? "已授权" : device.pendingSessionRequest ? "待授权" : "未授权";
    meta.textContent = `${device.version} · ${shortId(device.id)} · ${sessionText}`;
    button.append(name, meta);
    button.addEventListener("click", () => {
      state.selectedDeviceId = device.id;
      renderDevices();
    });
    elements.devices.append(button);
  }

  const selected = state.devices.find((device) => device.id === state.selectedDeviceId);
  elements.targetDevice.textContent = selected ? selected.name : "未选择设备";
}

async function executeCommand(action) {
  if (!state.selectedDeviceId) {
    appendResult({ action, error: "请先连接并选择浏览器" }, true);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(elements.payload.value || "{}");
  } catch {
    appendResult({ action, error: "Payload 不是合法 JSON" }, true);
    return;
  }

  elements.runCommand.disabled = true;
  const startedAt = performance.now();
  try {
    const response = await api("/api/commands", {
      method: "POST",
      body: JSON.stringify({
        deviceId: state.selectedDeviceId,
        action,
        payload,
        timeoutMs: action === "page.waitForSelector" ? 25000 : 15000
      })
    });
    appendResult({
      action,
      result: response.result,
      elapsedMs: Math.round(performance.now() - startedAt)
    });
  } catch (error) {
    appendResult({
      action,
      error: error.message,
      code: error.code || null,
      details: error.details || null,
      elapsedMs: Math.round(performance.now() - startedAt)
    }, true);
  } finally {
    elements.runCommand.disabled = false;
    await loadDevices();
  }
}

function appendResult(entry, isError = false) {
  elements.output.querySelector(".empty")?.remove();
  const container = document.createElement("article");
  container.className = `entry${isError ? " error" : ""}`;
  const head = document.createElement("div");
  head.className = "entry-head";
  const action = document.createElement("strong");
  action.textContent = entry.action;
  const meta = document.createElement("span");
  meta.textContent = isError ? "FAILED" : `OK · ${entry.elapsedMs ?? 0}ms`;
  head.append(action, meta);
  container.append(head);

  const dataUrl = entry.result?.dataUrl;
  const printable = dataUrl ? { ...entry.result, dataUrl: "[PNG omitted here]" } : entry;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(printable, null, 2);
  container.append(pre);
  if (dataUrl) {
    const image = document.createElement("img");
    image.alt = "页面截图";
    image.src = dataUrl;
    container.append(image);
  }
  elements.output.prepend(container);
}

function appendEmpty(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty";
  paragraph.textContent = text;
  elements.output.append(paragraph);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Authorization": `Bearer ${state.token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.code = body.code || null;
    error.details = body.details || null;
    throw error;
  }
  return body;
}

function startRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (!document.hidden) void loadDevices();
  }, 3000);
}

function logout() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  state.token = "";
  state.devices = [];
  state.selectedDeviceId = "";
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  elements.token.value = "";
  elements.workspace.classList.add("hidden");
  elements.authPanel.classList.remove("hidden");
  setServerStatus("未认证", "");
}

function setServerStatus(text, tone) {
  elements.serverStatus.textContent = text;
  elements.serverStatus.className = `server-status${tone ? ` ${tone}` : ""}`;
}

function shortId(id) {
  return id.length > 18 ? `${id.slice(0, 9)}…${id.slice(-6)}` : id;
}
