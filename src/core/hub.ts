import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import { createCipher } from "./cipher.js";
import { OAuth2 } from "./oauth2.js";
import { Store, newAppKey, type Account, type App, type CaptionsResult, type PublishRecord } from "./store.js";
import {
  ConnectorError,
  HubError,
  VISIBILITIES,
  type Capability,
  type Connector,
  type ConnectorContext,
  type Fetcher,
  type UploadInput,
} from "./types.js";
import { Vault } from "./vault.js";

type Env = Record<string, string | undefined>;

export type HubOptions = {
  home: string;
  env: Env;
  connectors: Connector[];
  /** Where the Hub is reachable, e.g. http://127.0.0.1:8790 (used for OAuth redirect URIs). */
  baseUrl: () => string;
  fetch?: Fetcher;
};

export type AccountView = { id: string; connector: string; name: string; status: Account["status"]; capabilities: Capability[] };

export type PublishState = "uploading" | "published" | "failed" | "unknown" | "abandoned";
export type PublishView = {
  publish_id: string;
  account: string;
  state: PublishState;
  title: string;
  visibility: string;
  external_id?: string;
  url?: string;
  captions?: CaptionsResult;
  error?: string;
  requested_at: string;
  finished_at?: string;
  already_published?: true;
};

const filePath = z.string().min(1).max(4096);
const language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/, "a language code such as en or fr-CA");
const captionsShape = z.object({ file_path: filePath, language, name: z.string().trim().min(1).max(150).optional() }).strict();
const publishShape = z
  .object({
    account: z.string().min(1).max(300),
    file_path: filePath,
    title: z.string().trim().min(1),
    description: z.string().default(""),
    tags: z.array(z.string().trim().min(1).max(100)).default([]),
    visibility: z.enum(VISIBILITIES).default("private"),
    confirm_public: z.boolean().optional(),
    options: z.record(z.string(), z.unknown()).default({}),
    captions: captionsShape.optional(),
    retry_unknown: z.boolean().optional(),
  })
  .strict();
const visibilityShape = z.object({ visibility: z.enum(VISIBILITIES), confirm_public: z.boolean().optional() }).strict();
const externalId = z.string().regex(/^[\w-]{1,200}$/, "a platform post id");

function parse<T>(shape: z.ZodType<T>, raw: unknown, what = "Input"): T {
  const result = shape.safeParse(raw ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  throw new HubError("invalid_input", `${what} is invalid: ${details}`);
}

const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Checks a caller's file and returns its real path. The type check uses the real file, so a symlink cannot disguise one. */
function checkFile(path: string, extensions: string[], maxBytes: number, what: string): string {
  if (!isAbsolute(path)) throw new HubError("invalid_input", `${what} must be an absolute path on this machine.`);
  let real: string;
  let size: number;
  try {
    real = realpathSync(path);
    const stat = statSync(real);
    if (!stat.isFile()) throw new Error();
    size = stat.size;
  } catch {
    throw new HubError("invalid_input", `${what} was not found: ${path}`);
  }
  for (const name of [path, real])
    if (!extensions.includes(extname(name).toLowerCase())) throw new HubError("invalid_input", `${what} must be one of: ${extensions.join(", ")} (links are followed).`);
  if (size === 0) throw new HubError("invalid_input", `${what} is empty.`);
  if (size > maxBytes) throw new HubError("invalid_input", `${what} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  return real;
}

/**
 * Everything shared by all platforms: accounts, app keys, the publish ledger, the safety rules and the audit log.
 * Connectors only talk to their platform.
 */
export class Hub {
  readonly store: Store;
  readonly oauth: OAuth2;
  private readonly registry = new Map<string, Connector>();
  private readonly fetch: Fetcher;
  private readonly running = new Map<string, Promise<void>>();
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private vaultInstance?: Vault;

  constructor(private readonly options: HubOptions) {
    this.store = new Store(options.home);
    this.fetch = options.fetch ?? fetch;
    this.oauth = new OAuth2(this.fetch);
    for (const c of options.connectors) {
      if (this.registry.has(c.id)) throw new Error(`Two connectors use the id ${c.id}`);
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(c.id)) throw new Error(`Connector id ${c.id} must be lowercase letters, digits or dashes`);
      this.registry.set(c.id, c);
    }
  }

  private get env() {
    return this.options.env;
  }

  private vault(): Vault {
    if (this.vaultInstance) return this.vaultInstance;
    const key = this.env.CHANNEL_HUB_MASTER_KEY;
    if (!key) throw new HubError("not_configured", "Set CHANNEL_HUB_MASTER_KEY in .env.local (for example: openssl rand -base64 48), then restart the Hub.");
    try {
      this.vaultInstance = new Vault(this.options.home, createCipher(key));
    } catch (err) {
      throw new HubError("not_configured", short(err));
    }
    return this.vaultInstance;
  }

  private connector(id: string): Connector {
    const found = this.registry.get(id);
    if (!found) throw new HubError("not_found", `No connector named ${id}. Installed: ${[...this.registry.keys()].join(", ") || "none"}.`);
    return found;
  }

  // ---- What is installed ----

  connectors() {
    return [...this.registry.values()].map((c) => ({
      id: c.id,
      name: c.name,
      auth: c.auth.kind,
      capabilities: c.capabilities,
      visibilities: c.visibilities,
      missing_credentials: c.credentials.filter((cred) => !this.env[cred.env]).map((cred) => cred.env),
      ...(c.auth.kind === "oauth2" ? { redirect_uri: this.redirectUri(c.id) } : {}),
    }));
  }

  private redirectUri(connectorId: string) {
    return `${this.options.baseUrl()}/oauth/callback/${connectorId}`;
  }

  private granted(connector: Connector, account: Account): Capability[] {
    const scopes = connector.auth.kind === "oauth2" ? connector.capabilityScopes : undefined;
    if (!scopes) return [...connector.capabilities];
    return connector.capabilities.filter((cap) => !scopes[cap] || scopes[cap]!.some((s) => account.scopes.includes(s)));
  }

  private view(account: Account): AccountView {
    const connector = this.registry.get(account.connector);
    return { id: account.id, connector: account.connector, name: account.name, status: account.status, capabilities: connector ? this.granted(connector, account) : [] };
  }

  // ---- Owner (admin) actions ----

  allAccounts(): AccountView[] {
    return this.store.accounts().map((a) => this.view(a));
  }

  startConnect(connectorId: string): { url: string; redirect_uri: string } {
    const connector = this.connector(connectorId);
    if (connector.auth.kind !== "oauth2") throw new HubError("unsupported", `${connector.name} connects with a key, not a browser sign-in.`);
    this.vault();
    const redirect = this.redirectUri(connectorId);
    return { url: this.oauth.start(connectorId, connector.auth, this.env, redirect), redirect_uri: redirect };
  }

  async finishConnect(connectorId: string, state: string, code: string): Promise<AccountView> {
    const connector = this.connector(connectorId);
    if (connector.auth.kind !== "oauth2") throw new HubError("unsupported", `${connector.name} does not use a browser sign-in.`);
    const pending = this.oauth.consume(state, connectorId);
    if (!pending) throw new HubError("invalid_input", "This sign-in link expired or was already used. Start connecting again.");
    const tokens = await this.oauth.exchange(connector.auth, this.env, code, pending.redirectUri, pending.verifier);
    const connected = await this.identify(connector, tokens.accessToken);
    const account = this.saveAccount(connector, connected, tokens.refreshToken, tokens.scopes ?? connector.auth.scopes);
    this.tokens.set(account.id, { token: tokens.accessToken, expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000 });
    return this.view(account);
  }

  async connectWithKey(connectorId: string, key: string): Promise<AccountView> {
    const connector = this.connector(connectorId);
    if (connector.auth.kind !== "api_key") throw new HubError("unsupported", `${connector.name} connects through a browser sign-in.`);
    if (!key) throw new HubError("invalid_input", "The key is empty.");
    this.vault();
    const connected = await this.identify(connector, key);
    return this.view(this.saveAccount(connector, connected, key, []));
  }

  private async identify(connector: Connector, accessToken: string) {
    try {
      return await connector.account({ accessToken, fetch: this.fetch });
    } catch (err) {
      if (err instanceof ConnectorError && (err.kind === "authorization" || err.kind === "permission"))
        throw new HubError("needs_reconnect", `${connector.name} refused the account: ${short(err)}`);
      throw new HubError("platform_error", `${connector.name} account lookup failed: ${short(err)}`);
    }
  }

  private saveAccount(connector: Connector, connected: { externalId: string; name: string }, secret: string, scopes: string[]): Account {
    const id = `${connector.id}:${connected.externalId}`;
    this.vault().put(id, secret);
    this.tokens.delete(id);
    const account = this.store.upsertAccount({ id, connector: connector.id, externalId: connected.externalId, name: connected.name, scopes, status: "connected" });
    this.store.audit({ action: "account_connected", account: id, scopes });
    return account;
  }

  addApp(name: string, accounts: string[]): { app: App; key: string } {
    const known = new Set(this.store.accounts().map((a) => a.id));
    const unknown = accounts.filter((a) => !known.has(a));
    if (unknown.length) throw new HubError("invalid_input", `Unknown accounts: ${unknown.join(", ")}. Connect them first.`);
    const key = newAppKey();
    let app: App;
    try {
      app = this.store.addApp(name, key, accounts);
    } catch (err) {
      throw new HubError("invalid_input", short(err));
    }
    this.store.audit({ action: "app_added", app: name, accounts });
    return { app, key };
  }

  setAppAccounts(name: string, accounts: string[]): void {
    const known = new Set(this.store.accounts().map((a) => a.id));
    const unknown = accounts.filter((a) => !known.has(a));
    if (unknown.length) throw new HubError("invalid_input", `Unknown accounts: ${unknown.join(", ")}.`);
    if (!this.store.setAppAccounts(name, accounts)) throw new HubError("not_found", `No app named ${name}.`);
    this.store.audit({ action: "app_accounts_changed", app: name, accounts });
  }

  listApps(): App[] {
    return this.store.apps();
  }

  removeApp(name: string): void {
    if (!this.store.removeApp(name)) throw new HubError("not_found", `No app named ${name}.`);
    this.store.audit({ action: "app_removed", app: name });
  }

  appForKey(key: string): App | undefined {
    return this.store.appForKey(key);
  }

  // ---- App actions ----

  accountsFor(app: App): AccountView[] {
    return this.store.accounts().filter((a) => app.accounts.includes(a.id)).map((a) => this.view(a));
  }

  /** Checks the app may use the account and the account can do this. */
  private usable(app: App, accountId: string, capability: Capability, needGrant = true) {
    const account = app.accounts.includes(accountId) ? this.store.account(accountId) : undefined;
    if (!account) throw new HubError("forbidden", `This app may not use the account ${accountId}.`);
    const connector = this.connector(account.connector);
    if (!connector.capabilities.includes(capability)) throw new HubError("unsupported", `${connector.name} does not support ${capability}.`);
    if (account.status === "needs_reconnect") throw new HubError("needs_reconnect", `Reconnect ${account.name} (${account.id}) in the Hub first.`);
    if (needGrant && !this.granted(connector, account).includes(capability))
      throw new HubError("needs_reconnect", `${account.name} was connected without permission for ${capability}. Reconnect it in the Hub.`);
    return { account, connector };
  }

  private async context(account: Account, connector: Connector): Promise<ConnectorContext> {
    const secret = () => {
      const value = this.vault().get(account.id);
      if (!value) throw new HubError("needs_reconnect", `No stored access for ${account.id}. Reconnect it.`);
      return value;
    };
    if (connector.auth.kind === "api_key") return { accessToken: secret(), fetch: this.fetch };
    const cached = this.tokens.get(account.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return { accessToken: cached.token, fetch: this.fetch };
    try {
      const fresh = await this.oauth.refresh(connector.auth, this.env, secret());
      this.tokens.set(account.id, { token: fresh.accessToken, expiresAt: Date.now() + (fresh.expiresIn ?? 3600) * 1000 });
      return { accessToken: fresh.accessToken, fetch: this.fetch };
    } catch (err) {
      if (err instanceof HubError && err.code === "needs_reconnect") this.store.setAccountStatus(account.id, "needs_reconnect");
      throw err;
    }
  }

  private stateOf(record: PublishRecord): PublishState {
    if (record.state === "requested") return this.running.has(record.id) ? "uploading" : "unknown";
    return record.state;
  }

  private publishView(record: PublishRecord): PublishView {
    return {
      publish_id: record.id,
      account: record.account,
      state: this.stateOf(record),
      title: record.title,
      visibility: record.visibility,
      ...(record.externalId ? { external_id: record.externalId } : {}),
      ...(record.url ? { url: record.url } : {}),
      ...(record.captions ? { captions: record.captions } : {}),
      ...(record.error ? { error: record.error } : {}),
      requested_at: record.requestedAt,
      ...(record.finishedAt ? { finished_at: record.finishedAt } : {}),
    };
  }

  /**
   * Starts a publish and returns at once (`uploading`); poll `publishStatus`. Rules:
   * private unless asked; public only with confirm_public; one publish per file per account; an upload whose outcome
   * is unknown blocks the same file until the caller confirms nothing reached the platform (retry_unknown).
   */
  async publish(app: App, raw: unknown): Promise<PublishView> {
    const input = parse(publishShape, raw, "Publish request");
    const { account, connector } = this.usable(app, input.account, "video.upload");
    const { limits } = connector;
    if (input.title.length > limits.title) throw new HubError("invalid_input", `Title is longer than ${limits.title} characters.`);
    if (input.description.length > limits.description) throw new HubError("invalid_input", `Description is longer than ${limits.description} characters.`);
    if (input.tags.length > limits.tags) throw new HubError("invalid_input", `More than ${limits.tags} tags.`);
    if (!connector.visibilities.includes(input.visibility)) throw new HubError("unsupported", `${connector.name} does not support ${input.visibility} posts.`);
    if (input.visibility === "public" && input.confirm_public !== true)
      throw new HubError("public_confirm", "This would be public. Send confirm_public: true to publish it publicly.");
    const options = parse(connector.options, input.options, `${connector.name} options`);
    const problem = connector.validate?.({ title: input.title, description: input.description, tags: input.tags, visibility: input.visibility, options });
    if (problem) throw new HubError("invalid_input", problem);
    const videoPath = checkFile(input.file_path, limits.extensions, limits.maxBytes, "The video file");
    let captions = input.captions;
    if (captions) {
      if (!connector.capabilities.includes("captions.upload") || !connector.captions) throw new HubError("unsupported", `${connector.name} does not support captions.`);
      captions = { ...captions, file_path: checkFile(captions.file_path, limits.captionsExtensions, 10 * 1024 * 1024, "The captions file") };
    }
    const contentHash = await sha256(videoPath);

    // No await from here until the worker starts, so two requests for the same file cannot both pass these checks.
    const prior = this.store.latestRecord(account.id, contentHash);
    if (prior) {
      const state = this.stateOf(prior);
      if (state === "published") return { ...this.publishView(prior), already_published: true };
      if (state === "uploading") throw new HubError("busy", "This file is being uploaded to this account now. Wait for it to finish.");
      if (state === "unknown") {
        if (input.retry_unknown !== true)
          throw new HubError(
            "outcome_unknown",
            `An earlier upload of this file (${prior.id}) stopped without a result. Check the platform; if it is not there, send retry_unknown: true.`,
          );
        this.store.updateRecord(prior.id, { state: "abandoned", finishedAt: new Date().toISOString() });
        this.store.audit({ action: "publish_unknown_released", app: app.name, account: account.id, publishId: prior.id, contentHash });
      }
    }
    const record = this.store.addRecord({ app: app.name, account: account.id, contentHash, title: input.title, visibility: input.visibility });
    this.store.audit({ action: "publish_requested", app: app.name, account: account.id, publishId: record.id, contentHash, visibility: input.visibility });
    const upload = { filePath: videoPath, title: input.title, description: input.description, tags: input.tags, visibility: input.visibility, options };
    const worker = this.work(app, account, connector, record, upload, captions).finally(() => this.running.delete(record.id));
    this.running.set(record.id, worker);
    return this.publishView(record);
  }

  private async work(app: App, account: Account, connector: Connector, record: PublishRecord, request: Omit<UploadInput, "bytes">, captions?: z.infer<typeof captionsShape>) {
    const log = { app: app.name, account: account.id, publishId: record.id, contentHash: record.contentHash };
    const finish = (patch: Partial<PublishRecord>) => this.store.updateRecord(record.id, { ...patch, finishedAt: new Date().toISOString() });
    let ctx: ConnectorContext;
    let input: UploadInput;
    try {
      // Read once and upload exactly these bytes, so the ledger's hash always matches what the platform received.
      const bytes: Buffer<ArrayBuffer> = await readFile(request.filePath).catch(() => Buffer.alloc(0));
      if (createHash("sha256").update(bytes).digest("hex") !== record.contentHash)
        throw new HubError("invalid_input", "The file changed or disappeared after the request. Publish it again.");
      input = { ...request, bytes };
      ctx = await this.context(account, connector);
    } catch (err) {
      finish({ state: "failed", error: short(err) });
      this.store.audit({ action: "publish_failed", ...log, error: short(err) });
      return;
    }
    let result: { externalId: string; url: string };
    try {
      result = await connector.upload(ctx, input);
    } catch (err) {
      if (err instanceof ConnectorError || err instanceof HubError) {
        if (err instanceof ConnectorError && err.kind === "authorization") this.tokens.delete(account.id);
        finish({ state: "failed", error: short(err) });
        this.store.audit({ action: "publish_failed", ...log, error: short(err) });
      } else {
        // The connection broke without a platform answer: the post may or may not exist. Never retry this by itself.
        finish({ state: "unknown", error: `No answer from ${connector.name}: ${short(err)}` });
        this.store.audit({ action: "publish_unknown", ...log, error: short(err) });
      }
      return;
    }
    finish({ state: "published", externalId: result.externalId, url: result.url });
    this.store.audit({ action: "publish_succeeded", ...log, externalId: result.externalId, visibility: input.visibility });
    if (!captions) return;

    // The post is up. A captions problem never undoes it.
    let outcome: CaptionsResult = "ok";
    if (!this.granted(connector, account).includes("captions.upload")) outcome = "needs-permission";
    else
      try {
        await connector.captions!(ctx, { externalId: result.externalId, filePath: captions.file_path, language: captions.language, name: captions.name ?? captions.language });
      } catch (err) {
        outcome = err instanceof ConnectorError && err.kind === "permission" ? "needs-permission" : "failed";
      }
    this.store.updateRecord(record.id, { captions: outcome });
    this.store.audit({ action: outcome === "ok" ? "captions_ok" : "captions_failed", ...log, externalId: result.externalId, result: outcome });
  }

  publishStatus(app: App, publishId: string): PublishView {
    const record = this.store.record(publishId);
    if (!record || !app.accounts.includes(record.account)) throw new HubError("not_found", `No publish ${publishId} for this app.`);
    return this.publishView(record);
  }

  private async platform<T>(connector: Connector, account: Account, what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof HubError) throw err;
      if (err instanceof ConnectorError && err.kind === "permission")
        throw new HubError("needs_reconnect", `${account.name} was connected without permission to ${what}. Reconnect it in the Hub.`);
      if (err instanceof ConnectorError && err.kind === "authorization") this.tokens.delete(account.id);
      throw new HubError("platform_error", `${connector.name} could not ${what}: ${short(err)}`);
    }
  }

  async captions(app: App, accountId: string, postId: string, raw: unknown): Promise<{ caption_id: string }> {
    const id = parse(externalId, postId, "Post id");
    const input = parse(captionsShape, raw, "Captions request");
    const { account, connector } = this.usable(app, accountId, "captions.upload");
    const captionsPath = checkFile(input.file_path, connector.limits.captionsExtensions, 10 * 1024 * 1024, "The captions file");
    const ctx = await this.context(account, connector);
    const log = { app: app.name, account: account.id, externalId: id };
    try {
      const result = await this.platform(connector, account, "add captions", () =>
        connector.captions!(ctx, { externalId: id, filePath: captionsPath, language: input.language, name: input.name ?? input.language }),
      );
      this.store.audit({ action: "captions_ok", ...log, language: input.language });
      return { caption_id: result.captionId };
    } catch (err) {
      this.store.audit({ action: "captions_failed", ...log, error: short(err) });
      throw err;
    }
  }

  async remoteStatus(app: App, accountId: string, postId: string) {
    const id = parse(externalId, postId, "Post id");
    const { account, connector } = this.usable(app, accountId, "video.status");
    const ctx = await this.context(account, connector);
    return this.platform(connector, account, "read the post", () => connector.status!(ctx, id));
  }

  async setVisibility(app: App, accountId: string, postId: string, raw: unknown): Promise<{ external_id: string; visibility: string }> {
    const id = parse(externalId, postId, "Post id");
    const input = parse(visibilityShape, raw, "Visibility change");
    const { account, connector } = this.usable(app, accountId, "video.visibility");
    if (!connector.visibilities.includes(input.visibility)) throw new HubError("unsupported", `${connector.name} does not support ${input.visibility} posts.`);
    if (input.visibility === "public" && input.confirm_public !== true)
      throw new HubError("public_confirm", "This would make the post public. Send confirm_public: true to do it.");
    const ctx = await this.context(account, connector);
    await this.platform(connector, account, "change visibility", () => connector.setVisibility!(ctx, id, input.visibility));
    this.store.audit({ action: "visibility_changed", app: app.name, account: account.id, externalId: id, visibility: input.visibility });
    return { external_id: id, visibility: input.visibility };
  }

  /** Resolves true when no upload is running, or false once `limitMs` has passed (for clean shutdown). */
  async idle(limitMs?: number): Promise<boolean> {
    const deadline = limitMs === undefined ? undefined : Date.now() + limitMs;
    while (this.running.size) {
      const all = Promise.allSettled([...this.running.values()]);
      if (deadline === undefined) await all;
      else {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<"late">((ok) => (timer = setTimeout(() => ok("late"), left)));
        const first = await Promise.race([all.then(() => "done" as const), late]);
        clearTimeout(timer);
        if (first === "late") return false;
      }
    }
    return true;
  }
}
