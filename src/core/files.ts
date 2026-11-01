import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Reads a JSON file, or `empty` when it does not exist. A corrupt file throws instead of being replaced. */
export function readJson<T>(path: string, empty: T): T {
  if (!existsSync(path)) return empty;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new Error(`${path.split("/").pop()} is not valid JSON. Fix or move it; the Hub will not overwrite it.`);
  }
}

/** Writes a JSON file atomically (temp file + rename), readable by the owner only. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${line}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
