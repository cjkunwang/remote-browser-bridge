import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function loadRuntimeConfig({ rootDir }) {
  const dataDir = path.join(rootDir, "data");
  const pairingFile = path.join(dataDir, "pairing.json");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  let token = process.env.BRIDGE_TOKEN?.trim() || "";
  let generated = false;

  if (!token) {
    try {
      const stored = JSON.parse(await readFile(pairingFile, "utf8"));
      token = typeof stored.token === "string" ? stored.token : "";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (!token) {
    token = randomBytes(24).toString("base64url");
    generated = true;
  }

  if (token.length < 16) {
    throw new Error("BRIDGE_TOKEN must contain at least 16 characters");
  }

  await writeFile(
    pairingFile,
    `${JSON.stringify({ token, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );

  return {
    token,
    generated,
    pairingFile,
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: parsePort(process.env.PORT)
  };
}

function parsePort(value) {
  if (!value) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  return port;
}
