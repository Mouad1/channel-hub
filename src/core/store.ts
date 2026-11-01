import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Visibility } from "./types.js";
import { appendLine, readJson, writeJson } from "./files.js";

export type AccountStatus = "connected" | "needs_reconnect";
export type Account = { id: string; connector: string; externalId: string; name: string; scopes: string[]; status: AccountStatus; connectedAt?: string };

export type App = { name: string; accounts: string[]; createdAt: string };
type StoredApp = App & { keyHash: string };

export type CaptionsResult = "ok" | "needs-permission" | "failed";
/** `requested` with no live worker means the Hub stopped mid-upload: the outcome is unknown. */
export type RecordState = "requested" | "published" | "failed" | "unknown" | "abandoned";
export type PublishRecord = {
  id: string;
  app: string;
  account: string;
  contentHash: string;
  title: string;
  visibility: Visibility;
  state: RecordState;
  externalId?: string;
  url?: string;
  captions?: CaptionsResult;
  error?: string;
  requestedAt: string;
  finishedAt?: string;
};

const hashKey = (key: string) => createHash("sha256").update(key).digest();

/** A new app key. Shown once; the Hub keeps only its hash. */
export function newAppKey(): string {
  return `chub_${randomBytes(32).toString("base64url")}`;
}

/** Accounts, apps, the publish ledger and the audit log, as plain files in the Hub's home folder. No secrets here. */
export class Store {
  constructor(readonly home: string) {}

  private file(name: string) {
    return join(this.home, name);
  }

  // Accounts
  accounts(): Account[] {
    return readJson<Account[]>(this.file("accounts.json"), []);
  }
  account(id: string): Account | undefined {
    return this.accounts().find((a) => a.id === id);
  }
  upsertAccount(account: Account): Account {
    const all = this.accounts().filter((a) => a.id !== account.id);
    const saved = { ...account, connectedAt: account.connectedAt ?? new Date().toISOString() };
    writeJson(this.file("accounts.json"), [...all, saved]);
    return saved;
  }
  setAccountStatus(id: string, status: AccountStatus): void {
    writeJson(this.file("accounts.json"), this.accounts().map((a) => (a.id === id ? { ...a, status } : a)));
  }

  // Apps
  private storedApps(): StoredApp[] {
    return readJson<StoredApp[]>(this.file("apps.json"), []);
  }
  apps(): App[] {
    return this.storedApps().map(({ keyHash: _hidden, ...app }) => app);
  }
  addApp(name: string, key: string, accounts: string[]): App {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error("App name: lowercase letters, digits, dot, dash or underscore (max 64).");
    const all = this.storedApps();
    if (all.some((a) => a.name === name)) throw new Error(`App ${name} already exists. Remove it first to issue a new key.`);
    const app: StoredApp = { name, accounts: [...new Set(accounts)], createdAt: new Date().toISOString(), keyHash: hashKey(key).toString("hex") };
    writeJson(this.file("apps.json"), [...all, app]);
    const { keyHash: _hidden, ...shown } = app;
    return shown;
  }
  setAppAccounts(name: string, accounts: string[]): boolean {
    const all = this.storedApps();
    if (!all.some((a) => a.name === name)) return false;
    writeJson(this.file("apps.json"), all.map((a) => (a.name === name ? { ...a, accounts: [...new Set(accounts)] } : a)));
    return true;
  }
  removeApp(name: string): boolean {
    const all = this.storedApps();
    const left = all.filter((a) => a.name !== name);
    if (left.length === all.length) return false;
    writeJson(this.file("apps.json"), left);
    return true;
  }
  appForKey(key: string): App | undefined {
    if (!key) return undefined;
    const given = hashKey(key);
    let found: StoredApp | undefined;
    for (const app of this.storedApps()) {
      const stored = Buffer.from(app.keyHash, "hex");
      if (stored.length === given.length && timingSafeEqual(stored, given)) found = app;
    }
    if (!found) return undefined;
    const { keyHash: _hidden, ...app } = found;
    return app;
  }

  // Publish ledger
  records(): PublishRecord[] {
    return readJson<PublishRecord[]>(this.file("ledger.json"), []);
  }
  record(id: string): PublishRecord | undefined {
    return this.records().find((r) => r.id === id);
  }
  latestRecord(account: string, contentHash: string): PublishRecord | undefined {
    return this.records().filter((r) => r.account === account && r.contentHash === contentHash).at(-1);
  }
  addRecord(input: Pick<PublishRecord, "app" | "account" | "contentHash" | "title" | "visibility">): PublishRecord {
    const record: PublishRecord = { ...input, id: `pub_${randomUUID()}`, state: "requested", requestedAt: new Date().toISOString() };
    writeJson(this.file("ledger.json"), [...this.records(), record]);
    return record;
  }
  updateRecord(id: string, patch: Partial<Omit<PublishRecord, "id">>): PublishRecord {
    let updated: PublishRecord | undefined;
    const all = this.records().map((r) => (r.id === id ? (updated = { ...r, ...patch }) : r));
    if (!updated) throw new Error(`Unknown publish record ${id}`);
    writeJson(this.file("ledger.json"), all);
    return updated;
  }

  // Audit
  audit(entry: { action: string } & Record<string, unknown>): void {
    appendLine(this.file("audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }));
  }
}
