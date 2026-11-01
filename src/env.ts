import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export type Env = Record<string, string | undefined>;

export const DEFAULT_PORT = 8790;
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile(path: string): Env {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8")) as Env;
}

/**
 * Settings come from the process environment first, then `<home>/.env.local`, then `.env.local` next to the package.
 * Values already set are never overwritten.
 */
export function loadEnv(processEnv: Env = process.env): { env: Env; home: string; port: number } {
  const fromPackage = readEnvFile(join(PACKAGE_ROOT, ".env.local"));
  // An empty line (e.g. `CHANNEL_HUB_HOME=` copied from .env.example) means "not set".
  const set = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());
  const home = resolve(set(processEnv.CHANNEL_HUB_HOME) ?? set(fromPackage.CHANNEL_HUB_HOME) ?? join(homedir(), ".channel-hub"));
  const fromHome = readEnvFile(join(home, ".env.local"));
  const env: Env = { ...fromPackage, ...fromHome, ...processEnv };
  const port = Number(set(env.CHANNEL_HUB_PORT) ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("CHANNEL_HUB_PORT must be a port number.");
  return { env, home, port };
}
