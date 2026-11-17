# Remote Browser Bridge

一个私有部署的 Chrome 扩展 + WebSocket Relay + 浏览器控制台。它让受信任的 Agent 或 QA Runner 通过白名单动作打开、跳转、关闭和操作标签页，并保留每次命令的执行结果。

## 架构

```text
Agent / QA Runner
        │ HTTP API
        ▼
Node.js Bridge ── WebSocket ── Chrome 扩展
        │                         │
        └── 控制台 UI             └── tabs / windows / page
```

- 服务端：鉴权、设备注册、命令转发、超时和 API
- 插件：执行 `chrome.tabs`、`chrome.windows` 和受限页面动作
- 控制台：查看设备、执行命令、展示结果和 PNG 截图
- 安全边界：浏览器本地会话授权；只允许 `http(s)` URL；页面写入禁止密码框；服务端与插件双重校验

## 浏览器本地授权

插件默认没有远端操作权限。远端发起敏感动作时，插件弹窗会出现待授权请求；用户批准后才建立本地会话：

- 默认范围：当前网站
- 默认有效期：30 分钟
- 空闲失效：5 分钟无远端命令自动失效
- 可选范围：当前页面 / 当前网站 / 所有 HTTP(S) 网站
- 可随时在插件弹窗点击“立即停止会话”

授权覆盖标签页管理、页面读取、页面操作、截图和标签页事件监控。未授权时 `tab.list` 只返回 HTTP(S) 标签页数量，不暴露标题或 URL；其他敏感命令返回 HTTP 403 和 `session_required`。

## 快速启动

```bash
pnpm install
pnpm start
```

首次启动会生成随机 Token，保存在权限为 `0600` 的 `data/pairing.json`，并打印控制台地址：

```text
控制台：http://127.0.0.1:8787
扩展地址：ws://127.0.0.1:8787/ws
```

也可以显式指定 Token 和端口：

```bash
BRIDGE_TOKEN='replace-with-a-long-random-token' PORT=8787 pnpm start
```

当前机器还配置了独立服务：

```bash
pnpm remote:info
```

它会输出 Tailnet 地址、当前公网 Quick Tunnel 地址和配对 Token。公网 Quick Tunnel 的域名在隧道进程重启后可能变化；需要固定公网域名时应启用 Tailscale Funnel 或配置有账号的 Cloudflare Named Tunnel。

出于安全考虑，`pnpm remote:info` 默认隐藏 Token。确需在当前终端显示时：

```bash
SHOW_PAIRING_TOKEN=1 pnpm remote:info
```

可通过 `BRIDGE_HOST`、`BRIDGE_PORT`、`BRIDGE_PUBLIC_URL` 和 `BRIDGE_TUNNEL_UNIT` 覆盖地址探测；不设置主机时会尝试使用本机 Tailscale IPv4。

## 安装 Chrome 扩展

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本项目的 `extension/` 目录。
4. 点击扩展图标，填写服务 Token 和设备名称。
5. 点击“保存并连接”；控制台应出现该浏览器。

扩展不使用 Chrome 商店。它请求目标站点的 host 权限，以便执行页面动作；安装时应使用专用或受控的 Chrome Profile。

升级已加载的插件时，在 `chrome://extensions` 点击插件的“重新加载”，然后重新打开插件弹窗。

## 控制台与 API

打开 `http://127.0.0.1:8787`，输入 Token 后即可查看设备并执行命令。

列出设备：

```bash
curl -sS http://127.0.0.1:8787/api/devices \
  -H "Authorization: Bearer $BRIDGE_TOKEN" | jq
```

打开页面：

```bash
curl -sS http://127.0.0.1:8787/api/commands \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"chrome_xxx","action":"tab.open","payload":{"url":"https://example.com"}}' | jq
```

关闭页面：

```bash
curl -sS http://127.0.0.1:8787/api/commands \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"chrome_xxx","action":"tab.close","payload":{"tabId":123}}' | jq
```

## 命令

| 动作 | 主要参数 |
|---|---|
| `tab.list` | 无 |
| `tab.open` | `url`, `active` |
| `tab.navigate` | `tabId`, `url` |
| `tab.close` | `tabId` |
| `tab.activate` | `tabId` |
| `tab.screenshot` | `tabId`，可选 |
| `window.open` | `url` |
| `window.close` | `windowId` |
| `page.click` | `tabId`, `selector` |
| `page.type` | `tabId`, `selector`, `text`, `submit` |
| `page.text` | `tabId`, `selector` |
| `page.waitForSelector` | `tabId`, `selector`, `waitTimeoutMs` |
| `page.scroll` | `tabId`, `deltaY` |

`tabId` 可省略时，页面动作会使用当前聚焦窗口的活动标签页。通用命令默认超时 15 秒，最大 60 秒。

为缩小敏感数据暴露面，`tab.list` 只返回 HTTP(S) 标签页；关闭、切换、截图和页面注入也拒绝 Chrome 内部页与本地文件页。

## 安全约束

- 默认只监听 `127.0.0.1`，不要直接暴露到公网。
- 若跨机器使用，必须通过 HTTPS/WSS 反向代理，并使用长随机 Token。
- Token 等价于浏览器操作权限；不要写入前端代码、日志或截图。
- 浏览器本地 Session 是第二道授权边界，不接受远端自行延长有效期或空闲时间。
- 插件不会保存或上传 Cookie、密码；`page.type` 明确拦截密码输入框。
- Chrome 的页面截图强制要求 `<all_urls>` 权限；服务端仍会拒绝非 HTTP(S) 的远程命令。
- 当前实现适合私有自动化和 QA 场景，不提供浏览器级 CDP 调试、系统弹窗控制或反风控能力。

## 验证

```bash
pnpm test
```

测试包含协议边界、Token 鉴权、WebSocket 配对、设备发现、命令请求/响应闭环，以及待授权目标的弹窗到后台透传回归。真实 Chromium E2E 还会验证未授权拒绝、批准、页面操作、截图、事件监控和停止会话后的再次拒绝。
