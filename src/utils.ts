import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { ApiErrorBody } from "./domain";

export function nowUnixMs(): number {
  return Date.now();
}

export function toIso(tsUnixMs: number | null | undefined): string | null {
  if (tsUnixMs === null || tsUnixMs === undefined) {
    return null;
  }
  return new Date(tsUnixMs).toISOString();
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await ensureDir(path.dirname(filePath));
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function appendLogLine(filePath: string, message: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

export async function parseJsonBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers,
  });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const body: { error: ApiErrorBody } = {
    error: {
      code,
      message,
      details,
    },
  };
  return jsonResponse(body, { status });
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

export function randomToken(bytes = 16): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeBase64Json<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

export async function sha256Hex(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ts = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function getRequiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) {
    throw new Error(`Missing required header: ${name}`);
  }
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
