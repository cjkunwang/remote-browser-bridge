const DEFAULT_SERVER_URL = "ws://127.0.0.1:8787/ws";
const elements = {
  status: document.querySelector("#status"),
  form: document.querySelector("#settings"),
  serverUrl: document.querySelector("#serverUrl"),
  token: document.querySelector("#token"),
  deviceName: document.querySelector("#deviceName"),
  autoConnect: document.querySelector("#autoConnect"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  deviceId: document.querySelector("#deviceId"),
  dashboard: document.querySelector("#dashboard"),
  sessionBadge: document.querySelector("#sessionBadge"),
  pendingSession: document.querySelector("#pendingSession"),
  pendingRequestText: document.querySelector("#pendingRequestText"),
  approvePending: document.querySelector("#approvePending"),
  denyPending: document.querySelector("#denyPending"),
  activeSession: document.querySelector("#activeSession"),
  activeScope: document.querySelector("#activeScope"),
  activeOrigin: document.querySelector("#activeOrigin"),
  activeExpiry: document.querySelector("#activeExpiry"),
  revokeSession: document.querySelector("#revokeSession"),
  sessionControls: document.querySelector("#sessionControls"),
  sessionScope: document.querySelector("#sessionScope"),
  sessionDuration: document.querySelector("#sessionDuration"),
  grantSession: document.querySelector("#grantSession")
};

void load();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.connectionState?.newValue) {
    void renderStatus(changes.connectionState.newValue);
  }
  if (areaName === "local" && (changes.remoteSession || changes.pendingSessionRequest)) {
    void renderSessionFromStorage();
  }
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await save();
  setBusy(true);
  try {
    await chrome.runtime.sendMessage({ type: "connection", action: "connect" });
  } finally {
    setBusy(false);
    await renderStatus();
  }
});

elements.disconnect.addEventListener("click", async () => {
  setBusy(true);
  try {
    await chrome.runtime.sendMessage({ type: "connection", action: "disconnect" });
  } finally {
    setBusy(false);
    await renderStatus();
  }
});

elements.grantSession.addEventListener("click", () => void grantSession());
elements.approvePending.addEventListener("click", () => void grantSession(true));
elements.denyPending.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "session", action: "deny" });
  renderSession(result);
});
elements.revokeSession.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "session", action: "revoke" });
  renderSession(result);
});
setInterval(() => void renderSessionFromStorage(), 1000);

async function load() {
  const stored = await chrome.storage.local.get([
    "serverUrl",
    "token",
    "deviceName",
    "deviceId",
    "autoConnect",
    "connectionState"
  ]);
  elements.serverUrl.value = stored.serverUrl || DEFAULT_SERVER_URL;
  elements.token.value = stored.token || "";
  elements.deviceName.value = stored.deviceName || "My Chrome";
  elements.autoConnect.checked = stored.autoConnect !== false;
  elements.deviceId.textContent = `设备 ID：${stored.deviceId || "尚未生成"}`;
  updateDashboardLink();
  renderStatus(stored.connectionState);
  await renderSessionFromStorage();
}

async function save() {
  await chrome.storage.local.set({
    serverUrl: elements.serverUrl.value.trim(),
    token: elements.token.value.trim(),
    deviceName: elements.deviceName.value.trim() || "My Chrome",
    autoConnect: elements.autoConnect.checked
  });
  updateDashboardLink();
}

async function renderStatus(provided) {
  const state = provided || await chrome.runtime.sendMessage({ type: "status" });
  const phase = state?.phase || "idle";
  const labels = {
    idle: "未连接",
    needs_pairing: "等待配对",
    connecting: "连接中",
    ready: "已连接",
    disconnected: "连接已断开",
    error: "连接失败"
  };
  elements.status.className = `status ${phase}`;
  elements.status.textContent = `${labels[phase] || phase}${state?.message ? ` · ${state.message}` : ""}`;
}

function updateDashboardLink() {
  try {
    const url = new URL(elements.serverUrl.value);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    elements.dashboard.href = url.toString();
  } catch {
    elements.dashboard.removeAttribute("href");
  }
}

function setBusy(value) {
  elements.connect.disabled = value;
  elements.disconnect.disabled = value;
}

async function grantSession(usePendingTarget = false) {
  const scope = elements.sessionScope.value;
  const durationMinutes = Number(elements.sessionDuration.value);
  if (scope === "all" && !confirm("允许远端操作所有 HTTP(S) 网站？")) return;

  const stored = await chrome.storage.local.get("pendingSessionRequest");
  const pending = usePendingTarget ? stored.pendingSessionRequest : null;
  const result = await chrome.runtime.sendMessage({
    type: "session",
    action: "grant",
    scope,
    durationMinutes,
    origin: pending?.origin || null,
    tabId: pending?.tabId || null
  });
  if (result?.error) {
    elements.pendingRequestText.textContent = result.error;
    return;
  }
  renderSession(result);
}

async function renderSessionFromStorage() {
  const stored = await chrome.storage.local.get(["remoteSession", "pendingSessionRequest"]);
  renderSession(stored);
}

function renderSession(data = {}) {
  const session = data.session || data.remoteSession || null;
  const pending = data.pendingSessionRequest || null;
  const now = Date.now();
  const active = session && now < Date.parse(session.expiresAt) && now < Date.parse(session.idleExpiresAt);

  elements.sessionBadge.className = `session-badge ${active ? "on" : pending ? "pending" : "off"}`;
  elements.sessionBadge.textContent = active ? "会话中" : pending ? "待授权" : "未授权";
  elements.activeSession.classList.toggle("hidden", !active);
  elements.sessionControls.classList.toggle("hidden", Boolean(active));
  elements.pendingSession.classList.toggle("hidden", !pending || Boolean(active));

  if (active) {
    elements.activeScope.textContent = session.scope === "all" ? "所有网站" : session.scope === "page" ? "仅当前页面" : "当前网站";
    elements.activeOrigin.textContent = session.origin || "当前标签页";
    elements.activeExpiry.textContent = `止于 ${formatTime(Math.min(Date.parse(session.expiresAt), Date.parse(session.idleExpiresAt)))}`;
  }

  if (pending) {
    elements.pendingRequestText.textContent = `${pending.action} · ${pending.origin || "当前标签页"}`;
  }
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
