/**
 * A small typed client for apps. Copy it into your app, or call the HTTP API directly (see README).
 * Reads CHANNEL_HUB_URL and CHANNEL_HUB_KEY by default.
 */
export type Visibility = "private" | "unlisted" | "public";

export type PublishRequest = {
  account: string;
  file_path: string;
  title: string;
  description?: string;
  tags?: string[];
  visibility?: Visibility;
  confirm_public?: boolean;
  options?: Record<string, unknown>;
  captions?: { file_path: string; language: string; name?: string };
  retry_unknown?: boolean;
};

export type PublishView = {
  publish_id: string;
  account: string;
  state: "uploading" | "published" | "failed" | "unknown" | "abandoned";
  title: string;
  visibility: Visibility;
  external_id?: string;
  url?: string;
  captions?: "ok" | "needs-permission" | "failed";
  error?: string;
  requested_at: string;
  finished_at?: string;
  already_published?: true;
};

export class ChannelHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ChannelHubError";
  }
}

export class ChannelHubClient {
  private readonly url: string;
  private readonly key: string;

  constructor(options: { url?: string; key?: string; fetch?: typeof fetch } = {}) {
    this.url = (options.url ?? process.env.CHANNEL_HUB_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
    const key = options.key ?? process.env.CHANNEL_HUB_KEY;
    if (!key) throw new ChannelHubError("not_configured", "Set CHANNEL_HUB_KEY (written by: channel-hub apps add <name> --write-env <path>).", 0);
    this.key = key;
    if (options.fetch) this.fetcher = options.fetch;
  }

  private fetcher: typeof fetch = (...args) => fetch(...args);

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}${path}`, {
        method,
        headers: { "x-channel-hub-key": this.key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ChannelHubError("unreachable", `Channel Hub is not reachable at ${this.url}. Start it with: channel-hub start`, 0);
    }
    const payload = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    if (!response.ok) throw new ChannelHubError(payload.code ?? "error", payload.message ?? `HTTP ${response.status}`, response.status);
    return payload as T;
  }

  accounts() {
    return this.call<{ accounts: { id: string; connector: string; name: string; status: string; capabilities: string[] }[] }>("GET", "/v1/accounts");
  }
  publish(request: PublishRequest) {
    return this.call<PublishView>("POST", "/v1/publish", request);
  }
  publishStatus(publishId: string) {
    return this.call<PublishView>("GET", `/v1/publish/${encodeURIComponent(publishId)}`);
  }
  postStatus(account: string, externalId: string) {
    return this.call<{ visibility?: Visibility; state: string; detail?: string; url?: string }>("GET", `/v1/posts/${encodeURIComponent(account)}/${encodeURIComponent(externalId)}`);
  }
  captions(account: string, externalId: string, captions: { file_path: string; language: string; name?: string }) {
    return this.call<{ caption_id: string }>("POST", `/v1/posts/${encodeURIComponent(account)}/${encodeURIComponent(externalId)}/captions`, captions);
  }
  setVisibility(account: string, externalId: string, visibility: Visibility, confirmPublic = false) {
    return this.call<{ external_id: string; visibility: Visibility }>("PATCH", `/v1/posts/${encodeURIComponent(account)}/${encodeURIComponent(externalId)}`, {
      visibility,
      ...(confirmPublic ? { confirm_public: true } : {}),
    });
  }
}
