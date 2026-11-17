import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBridgeServer } from "./bridge.mjs";
import { loadRuntimeConfig } from "./config.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadRuntimeConfig({ rootDir });
const bridge = createBridgeServer({ token: config.token });
const address = await bridge.start({ host: config.host, port: config.port });
const port = typeof address === "object" ? address.port : config.port;

console.log(`[bridge] listening on http://${config.host}:${port}`);
console.log("[bridge] control console:", `http://${config.host}:${port}`);
console.log("[bridge] extension WebSocket:", `ws://${config.host}:${port}/ws`);
console.log(`[bridge] pairing file: ${config.pairingFile}${config.generated ? " (generated)" : ""}`);

async function shutdown(signal) {
  console.log(`[bridge] ${signal}, shutting down`);
  await bridge.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
