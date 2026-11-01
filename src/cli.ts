#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setEnvValues } from "./envfile.js";
import { createRuntime } from "./runtime.js";
import { HEALTH_NAME, startServer } from "./server.js";

const HELP = `Channel Hub: connect your publishing accounts once, publish from any app or assistant.

Usage: channel-hub <command>

  start                         Run the Hub (HTTP on 127.0.0.1). Keep it running.
  doctor                        Check settings and connectors (prints names, never values).
  connect <connector>           Connect an account in your browser (e.g. connect youtube). --no-open to only print the link.
  connect-key <connector>       Connect an account with a key read from stdin.
  accounts                      List connected accounts.
  apps list                     List apps and the accounts each may use.
  apps add <name> --accounts <id,...> --write-env <path/.env.local>
                                Create an app key and write it into that app's .env.local (never printed).
                                Use --print instead of --write-env to show it once.
  apps set-accounts <name> --accounts <id,...>
  apps remove <name>            Revoke an app's key.
`;

const rt = createRuntime();
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const base = () => `http://127.0.0.1:${rt.port}`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function running(): Promise<boolean> {
  const health = (await fetch(`${base()}/health`, { signal: AbortSignal.timeout(2000) }).then(
    (r) => r.json(),
    () => null,
  )) as { name?: string } | null;
  return health?.name === HEALTH_NAME;
}

async function admin<T>(method: string, path: string, body?: unknown): Promise<T> {
  const tokenFile = join(rt.home, "admin-token.json");
  if (!(await running()) || !existsSync(tokenFile)) fail(`Channel Hub is not running at ${base()}. Start it with: channel-hub start`);
  const token = (JSON.parse(readFileSync(tokenFile, "utf8")) as { token: string }).token;
  const response = await fetch(`${base()}${path}`, {
    method,
    headers: { "x-channel-hub-admin": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) fail(payload.message ?? `HTTP ${response.status}`);
  return payload as T;
}

const accountsFlag = () => (flag("--accounts") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
};

const [command, sub] = args;
switch (command) {
  case "start": {
    const result = await startServer(rt.hub, { home: rt.home, port: rt.port, onListen: rt.setPort });
    if (result.role === "client") fail(`Channel Hub is already running at ${base()}.`);
    if (result.role === "none") fail(`Port ${rt.port} is used by another program. Set CHANNEL_HUB_PORT in .env.local.`);
    if (result.role !== "owner") fail("Could not start the Hub.");
    const close = result.close;
    process.stdout.write(`Channel Hub running at http://127.0.0.1:${result.port} (data: ${rt.home})\n`);
    const stop = async () => {
      process.stdout.write("Stopping: waiting up to 2 minutes for running uploads to finish...\n");
      if (!(await rt.hub.idle(120_000))) process.stdout.write("Some uploads did not finish; they will show as unknown. Check the platform before retrying.\n");
      await close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    break;
  }
  case "doctor": {
    const key = rt.env.CHANNEL_HUB_MASTER_KEY;
    const lines = [
      "Channel Hub doctor",
      `  home                    ${rt.home}`,
      `  CHANNEL_HUB_MASTER_KEY  ${!key ? "missing" : key.length < 32 ? "too short (32+ characters)" : "set"}`,
      `  hub                     ${(await running()) ? `running at ${base()}` : `not running (channel-hub start)`}`,
    ];
    for (const c of rt.hub.connectors()) {
      lines.push(`  connector ${c.id} (${c.name}): ${c.missing_credentials.length ? `missing ${c.missing_credentials.join(", ")}` : "ready"}`);
      if (c.redirect_uri) lines.push(`    redirect URI to allow: ${c.redirect_uri.replace(/:\d+\//, `:${rt.port}/`)}`);
    }
    if (rt.env.CHANNEL_HUB_TEST_GOOGLE_BASE_URL) lines.push("  warning: CHANNEL_HUB_TEST_GOOGLE_BASE_URL is set, so Google calls go to a test server. Unset it for real use.");
    process.stdout.write(`${lines.join("\n")}\n`);
    break;
  }
  case "connect": {
    if (!sub) fail("Which connector? e.g. channel-hub connect youtube");
    const { url } = await admin<{ url: string }>("POST", `/admin/connect/${encodeURIComponent(sub)}`);
    process.stdout.write(`Open this link and approve access:\n${url}\nThen check with: channel-hub accounts\n`);
    if (!has("--no-open")) execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url], () => {});
    break;
  }
  case "connect-key": {
    if (!sub) fail("Which connector?");
    if (process.stdin.isTTY) process.stderr.write("Paste the key, then press Enter and Ctrl-D:\n");
    const key = await readStdin();
    const { account } = await admin<{ account: { id: string; name: string } }>("POST", `/admin/connect-key/${encodeURIComponent(sub)}`, { key });
    process.stdout.write(`Connected ${account.name} (${account.id})\n`);
    break;
  }
  case "accounts": {
    const { accounts } = await admin<{ accounts: { id: string; name: string; status: string; capabilities: string[] }[] }>("GET", "/admin/accounts");
    if (!accounts.length) process.stdout.write("No accounts yet. Connect one: channel-hub connect youtube\n");
    for (const a of accounts) process.stdout.write(`${a.id}  ${a.name}  ${a.status}  ${a.capabilities.join(",")}\n`);
    break;
  }
  case "apps": {
    if (sub === "list" || !sub) {
      const { apps } = await admin<{ apps: { name: string; accounts: string[] }[] }>("GET", "/admin/apps");
      if (!apps.length) process.stdout.write("No apps yet.\n");
      for (const a of apps) process.stdout.write(`${a.name}  ${a.accounts.join(",") || "(no accounts)"}\n`);
    } else if (sub === "add") {
      const name = args[2];
      const target = flag("--write-env");
      if (!name || name.startsWith("--")) fail("Usage: channel-hub apps add <name> --accounts <id,...> --write-env <path/.env.local>");
      if (!target && !has("--print")) fail("Give --write-env <path/.env.local> so the key goes straight into the app's settings (or --print to show it once).");
      const { key } = await admin<{ key: string }>("POST", "/admin/apps", { name, accounts: accountsFlag() });
      if (target) {
        setEnvValues(resolve(target), { CHANNEL_HUB_URL: base(), CHANNEL_HUB_KEY: key });
        process.stdout.write(`App ${name} created. CHANNEL_HUB_URL and CHANNEL_HUB_KEY written to ${resolve(target)}\n`);
      } else {
        process.stderr.write("Shown once. Store it in the app's .env.local, never in code or chat.\n");
        process.stdout.write(`${key}\n`);
      }
    } else if (sub === "set-accounts") {
      await admin("PUT", `/admin/apps/${encodeURIComponent(args[2] ?? "")}/accounts`, { accounts: accountsFlag() });
      process.stdout.write("Updated.\n");
    } else if (sub === "remove") {
      await admin("DELETE", `/admin/apps/${encodeURIComponent(args[2] ?? "")}`);
      process.stdout.write(`App ${args[2]} removed; its key no longer works.\n`);
    } else fail(HELP);
    break;
  }
  default:
    process.stdout.write(HELP);
}
