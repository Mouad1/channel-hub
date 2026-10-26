import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Sets KEY=value lines in an app's .env file, replacing existing ones and keeping every other line. */
export function setEnvValues(path: string, values: Record<string, string>): void {
  const name = basename(path);
  if (!name.startsWith(".env") || !name.endsWith(".local"))
    throw new Error(`Refusing to write a key into ${name}: use the app's git-ignored .env.local (a name ending in .local).`);
  const lines = existsSync(path) ? readFileSync(path, "utf8").replace(/\n$/, "").split("\n") : [];
  const left = { ...values };
  const out = lines.map((line) => {
    const name = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (name && name in left) {
      const value = left[name]!;
      delete left[name];
      return `${name}=${value}`;
    }
    return line;
  });
  for (const [name, value] of Object.entries(left)) out.push(`${name}=${value}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${out.filter((l, i) => l !== "" || i < out.length - 1).join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
