import { createHash, randomBytes } from "node:crypto";
import { HubError, type Fetcher, type OAuth2Spec } from "./types.js";

type Env = Record<string, string | undefined>;
type Pending = { connectorId: string; redirectUri: string; verifier?: string; expiresAt: number };

export type Tokens = { accessToken: string; refreshToken: string; expiresIn?: number; scopes?: string[] };

function client(spec: OAuth2Spec, env: Env) {
  const id = env[spec.clientIdEnv];
  const secret = env[spec.clientSecretEnv];
  if (!id || !secret) throw new HubError("not_configured", `Set ${spec.clientIdEnv} and ${spec.clientSecretEnv} in .env.local, then restart the Hub.`);
  return { id, secret };
}

/**
 * The OAuth 2.0 authorization-code flow, the same for every connector. `state` is single-use, tied to one connector and
 * short-lived; PKCE is added when the connector says the provider supports it.
 */
export class OAuth2 {
  private readonly pending = new Map<string, Pending>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly fetch: Fetcher,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  start(connectorId: string, spec: OAuth2Spec, env: Env, redirectUri: string): string {
    const { id } = client(spec, env);
    for (const [key, p] of this.pending) if (p.expiresAt <= this.now()) this.pending.delete(key);
    const state = randomBytes(32).toString("base64url");
    const verifier = spec.pkce ? randomBytes(48).toString("base64url") : undefined;
    this.pending.set(state, { connectorId, redirectUri, verifier, expiresAt: this.now() + this.ttlMs });
    const params = new URLSearchParams({ client_id: id, redirect_uri: redirectUri, response_type: "code", scope: spec.scopes.join(" "), state, ...spec.extraParams });
    if (verifier) {
      params.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      params.set("code_challenge_method", "S256");
    }
    return `${spec.authorizeUrl}?${params}`;
  }

  /** Returns the pending connection for this state once; later calls, other connectors and expired states get nothing. */
  consume(state: string, connectorId: string): Pending | undefined {
    const found = this.pending.get(state);
    if (!found) return undefined;
    this.pending.delete(state);
    if (found.connectorId !== connectorId || found.expiresAt <= this.now()) return undefined;
    return found;
  }

  async exchange(spec: OAuth2Spec, env: Env, code: string, redirectUri: string, verifier?: string): Promise<Tokens> {
    const { id, secret } = client(spec, env);
    const form = new URLSearchParams({ grant_type: "authorization_code", code, client_id: id, client_secret: secret, redirect_uri: redirectUri });
    if (verifier) form.set("code_verifier", verifier);
    const body = await this.post(spec.tokenUrl, form, "Authorization failed. Start connecting again.");
    if (!body.access_token || !body.refresh_token)
      throw new HubError("platform_error", "The provider gave no refresh token. Start connecting again and accept every permission on the consent page.");
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      ...(body.expires_in ? { expiresIn: body.expires_in } : {}),
      ...(body.scope ? { scopes: body.scope.split(/\s+/).filter(Boolean) } : {}),
    };
  }

  async refresh(spec: OAuth2Spec, env: Env, refreshToken: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const { id, secret } = client(spec, env);
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: id, client_secret: secret });
    const body = await this.post(spec.tokenUrl, form, "Could not refresh the account's access.");
    if (!body.access_token) throw new HubError("platform_error", "The provider's token answer had no access token.");
    return { accessToken: body.access_token, ...(body.expires_in ? { expiresIn: body.expires_in } : {}) };
  }

  private async post(url: string, form: URLSearchParams, failure: string) {
    let response: Response;
    try {
      response = await this.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    } catch {
      throw new HubError("platform_error", `${failure} The provider could not be reached.`);
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!response.ok) {
      if (body.error === "invalid_grant") throw new HubError("needs_reconnect", "The account's access was revoked or has expired. Reconnect the account.");
      throw new HubError("platform_error", `${failure} (HTTP ${response.status})`);
    }
    return body;
  }
}
