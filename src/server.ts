import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { writeJson } from "./core/files.js";
import type { Hub } from "./core/hub.js";
import type { App } from "./core/store.js";
import { HubError } from "./core/types.js";

export const HEALTH_NAME = "channel-hub";
const MAX_BODY = 64 * 1024;

/** The owner's admin token, created once, readable by the owner only. Used by the CLI; never sent to apps. */
export function adminToken(home: string): string {
  const path = join(home, "admin-token.json");
  if (existsSync(path)) return (JSON.parse(readFileSync(path, "utf8")) as { token: string }).token;
  const token = randomBytes(32).toString("base64url");
  writeJson(path, { token });
  return token;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (res: ServerResponse, status: number, title: string, text: string) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`,
  );
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HubError("invalid_input", "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HubError("invalid_input", "Request body must be JSON.");
  }
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

const sameSecret = (given: string, expected: string) => timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());

function pathParts(path: string): string[] {
  try {
    return path.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
  } catch {
    throw new HubError("invalid_input", "The address has a broken % escape.");
  }
}

export type Running = { role: "owner"; port: number; server: Server; close(): Promise<void> } | { role: "client" | "none"; port: number };

/**
 * Serves the Hub on 127.0.0.1. Returns "client" when another Channel Hub already owns the port, "none" when something
 * else does. Checks: Host header (DNS rebinding), no cross-site browser requests, admin token or app key on every call.
 */
export async function startServer(hub: Hub, options: { home: string; port: number; onListen?: (port: number) => void }): Promise<Running> {
  const admin = adminToken(options.home);
  let port = options.port;
  const allowed = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer(async (req, res) => {
    try {
      if (!allowed().has(req.headers.host ?? "")) return json(res, 403, { code: "forbidden", message: "Bad host." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") return json(res, 200, { name: HEALTH_NAME });

      // The consent page sends the browser back here. The single-use state proves the owner started it.
      const callback = path.match(/^\/oauth\/callback\/([a-z][a-z0-9-]*)$/);
      if (method === "GET" && callback) {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (url.searchParams.get("error") || !code) return page(res, 400, "Not connected", "The sign-in was cancelled or refused. Start connecting again from the Hub.");
        try {
          const account = await hub.finishConnect(callback[1]!, state, code);
          return page(res, 200, "Connected", `${account.name} (${account.id}) is connected to Channel Hub. You can close this tab.`);
        } catch (err) {
          return page(res, err instanceof HubError ? err.status : 500, "Not connected", err instanceof HubError ? err.message : "Something went wrong. Start connecting again.");
        }
      }

      // Browsers send Origin on cross-site requests; the Hub has no web UI that calls this API.
      const origin = headerValue(req, "origin");
      if (origin && !allowed().has(origin.replace(/^https?:\/\//, ""))) return json(res, 403, { code: "forbidden", message: "Cross-site requests are not allowed." });

      if (path.startsWith("/admin/")) {
        if (!sameSecret(headerValue(req, "x-channel-hub-admin"), admin)) return json(res, 401, { code: "unauthorized", message: "Missing or wrong admin token." });
        return await adminRoute(hub, method, path, req, res);
      }

      if (path.startsWith("/v1/")) {
        const key = headerValue(req, "x-channel-hub-key") || headerValue(req, "authorization").replace(/^Bearer\s+/i, "");
        const app = hub.appForKey(key);
        if (!app) return json(res, 401, { code: "unauthorized", message: "Missing or wrong app key (header x-channel-hub-key)." });
        return await appRoute(hub, app, method, path, req, res);
      }
      json(res, 404, { code: "not_found", message: "Not found." });
    } catch (err) {
      if (err instanceof HubError) return json(res, err.status, { code: err.code, message: err.message });
      process.stderr.write(`channel-hub: ${err instanceof Error ? err.stack : String(err)}\n`);
      json(res, 500, { code: "internal", message: "Internal error. See the Hub's log." });
    }
  });

  const listening = await new Promise<boolean>((ok) => {
    server.once("error", () => ok(false));
    server.listen(options.port, "127.0.0.1", () => ok(true));
  });
  if (listening) {
    port = (server.address() as AddressInfo).port;
    options.onListen?.(port);
    return {
      role: "owner",
      port,
      server,
      close: () =>
        new Promise<void>((ok) => {
          server.close(() => ok());
          server.closeAllConnections();
        }),
    };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const other = (await fetch(`http://127.0.0.1:${options.port}/health`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.json(),
      () => null,
    )) as { name?: string } | null;
    if (other?.name === HEALTH_NAME) return { role: "client", port: options.port };
    if (other) return { role: "none", port: options.port };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { role: "none", port: options.port };
}

async function adminRoute(hub: Hub, method: string, path: string, req: IncomingMessage, res: ServerResponse) {
  const parts = pathParts(path);
  const body = method === "POST" || method === "PUT" ? ((await readJsonBody(req)) as Record<string, unknown>) : {};
  const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : (() => { throw new HubError("invalid_input", "accounts must be a list of account ids."); })());

  if (method === "GET" && path === "/admin/connectors") return json(res, 200, { connectors: hub.connectors() });
  if (method === "GET" && path === "/admin/accounts") return json(res, 200, { accounts: hub.allAccounts() });
  if (method === "POST" && parts[0] === "connect" && parts.length === 2) return json(res, 200, hub.startConnect(parts[1]!));
  if (method === "POST" && parts[0] === "connect-key" && parts.length === 2) {
    if (typeof body.key !== "string") throw new HubError("invalid_input", "key is required.");
    return json(res, 200, { account: await hub.connectWithKey(parts[1]!, body.key) });
  }
  if (method === "GET" && path === "/admin/apps") return json(res, 200, { apps: hub.listApps() });
  if (method === "POST" && path === "/admin/apps") {
    if (typeof body.name !== "string") throw new HubError("invalid_input", "name is required.");
    return json(res, 201, hub.addApp(body.name, list(body.accounts ?? [])));
  }
  if (method === "PUT" && parts[0] === "apps" && parts.length === 3 && parts[2] === "accounts") {
    hub.setAppAccounts(parts[1]!, list(body.accounts));
    return json(res, 200, { ok: true });
  }
  if (method === "DELETE" && parts[0] === "apps" && parts.length === 2) {
    hub.removeApp(parts[1]!);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { code: "not_found", message: "Not found." });
}

async function appRoute(hub: Hub, app: App, method: string, path: string, req: IncomingMessage, res: ServerResponse) {
  const parts = pathParts(path);
  if (method === "GET" && path === "/v1/connectors") return json(res, 200, { connectors: hub.connectors().map(({ redirect_uri: _r, missing_credentials: _m, ...c }) => c) });
  if (method === "GET" && path === "/v1/accounts") return json(res, 200, { accounts: hub.accountsFor(app) });
  if (method === "POST" && path === "/v1/publish") {
    const view = await hub.publish(app, await readJsonBody(req));
    return json(res, view.already_published ? 200 : 202, view);
  }
  if (method === "GET" && parts[0] === "publish" && parts.length === 2) return json(res, 200, hub.publishStatus(app, parts[1]!));
  if (parts[0] === "posts" && parts.length >= 3) {
    const [, account, id, sub] = parts as [string, string, string, string | undefined];
    if (method === "GET" && parts.length === 3) return json(res, 200, await hub.remoteStatus(app, account, id));
    if (method === "PATCH" && parts.length === 3) return json(res, 200, await hub.setVisibility(app, account, id, await readJsonBody(req)));
    if (method === "POST" && sub === "captions" && parts.length === 4) return json(res, 200, await hub.captions(app, account, id, await readJsonBody(req)));
  }
  json(res, 404, { code: "not_found", message: "Not found." });
}
