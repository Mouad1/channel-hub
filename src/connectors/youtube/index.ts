import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { ConnectorError, UnknownOutcome, type Connector, type ConnectorContext, type Visibility } from "../../core/types.js";

const SCOPE = {
  upload: "https://www.googleapis.com/auth/youtube.upload",
  readonly: "https://www.googleapis.com/auth/youtube.readonly",
  forceSsl: "https://www.googleapis.com/auth/youtube.force-ssl",
  full: "https://www.googleapis.com/auth/youtube",
};

const GOOGLE_UPLOAD_ORIGINS = ["https://upload.youtube.com", "https://www.googleapis.com", "https://youtube.googleapis.com"];
const CONTENT_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

/** The resumable upload URL comes from a response header; only ever send the video to Google (or the test base). */
export function validateUploadSessionUrl(value: string, extraOrigins: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConnectorError("invalid", "Invalid YouTube upload session URL");
  }
  const google = parsed.protocol === "https:" && GOOGLE_UPLOAD_ORIGINS.includes(parsed.origin);
  if (parsed.username || parsed.password || !(google || extraOrigins.includes(parsed.origin))) throw new ConnectorError("invalid", "Invalid YouTube upload session URL");
  return parsed.toString();
}

const options = z
  .object({
    /** Required by YouTube policy and by this Hub: no silent default. */
    made_for_kids: z.boolean(),
    /** Sets status.containsSyntheticMedia ("altered or synthetic content" label). */
    ai_label: z.boolean(),
    /** Sets snippet.defaultLanguage and snippet.defaultAudioLanguage. */
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/).optional(),
    category_id: z.string().regex(/^\d{1,3}$/).optional(),
  })
  .strict();
type Options = z.infer<typeof options>;

type ErrorBody = { error?: { message?: string; errors?: { reason?: string }[] } };

async function failure(response: Response, what: string): Promise<ConnectorError> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  const reason = body.error?.errors?.[0]?.reason ?? "";
  const status = response.status;
  const message = `${what} (HTTP ${status}${reason ? `, ${reason}` : ""})`;
  if (status === 401) return new ConnectorError("authorization", message, status);
  if (status === 403 && (reason === "insufficientPermissions" || reason === "forbidden")) return new ConnectorError("permission", message, status);
  if (status === 403 || status === 429) return new ConnectorError("quota", `${message}. YouTube quota or upload limit reached; try again tomorrow.`, status);
  if (status === 404 || status === 410) return new ConnectorError("session_expired", message, status);
  if (status === 408 || status >= 500) return new ConnectorError("transient", message, status);
  return new ConnectorError("invalid", message, status);
}

/** Wraps a fetch that sends no video bytes: a network error there means nothing was published. */
async function call(ctx: ConnectorContext, url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await ctx.fetch(url, init);
  } catch (err) {
    throw new ConnectorError("transient", `${what}: YouTube could not be reached (${err instanceof Error ? err.message : String(err)})`);
  }
}

export type YouTubeConfig = {
  /** Test only: send every Google call (OAuth and API) to this base, e.g. a local fake. Loopback addresses only. */
  googleBaseUrl?: string;
  /** How long the video upload may take before its outcome is recorded as unknown. Default 30 minutes. */
  uploadTimeoutMs?: number;
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** YouTube via the YouTube Data API v3. */
export function youtubeConnector(config: YouTubeConfig = {}): Connector {
  const base = config.googleBaseUrl?.replace(/\/$/, "");
  if (base && !LOOPBACK.has(new URL(base).hostname))
    throw new Error("CHANNEL_HUB_TEST_GOOGLE_BASE_URL must be a loopback address (a local test server). Remove it for real use.");
  const uploadTimeoutMs = config.uploadTimeoutMs ?? 30 * 60_000;
  const api = base ?? "https://www.googleapis.com";
  const extraOrigins = base ? [new URL(base).origin] : [];
  const bearer = (ctx: ConnectorContext) => ({ authorization: `Bearer ${ctx.accessToken}` });

  async function readStatus(ctx: ConnectorContext, id: string) {
    const response = await call(ctx, `${api}/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`, { headers: bearer(ctx) }, "Reading the video failed");
    if (!response.ok) throw await failure(response, "Reading the video failed");
    const body = (await response.json()) as { items?: { status?: Record<string, unknown>; processingDetails?: { processingStatus?: string } }[] };
    const item = body.items?.[0];
    if (!item?.status) throw new ConnectorError("invalid", `Video ${id} was not found on this channel`, 404);
    return item;
  }

  return {
    id: "youtube",
    name: "YouTube",
    credentials: [
      { env: "GOOGLE_CLIENT_ID", label: "Google OAuth client ID", secret: false },
      { env: "GOOGLE_CLIENT_SECRET", label: "Google OAuth client secret", secret: true },
    ],
    auth: {
      kind: "oauth2",
      authorizeUrl: base ? `${base}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: base ? `${base}/token` : "https://oauth2.googleapis.com/token",
      scopes: [SCOPE.upload, SCOPE.readonly, SCOPE.forceSsl],
      clientIdEnv: "GOOGLE_CLIENT_ID",
      clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
      pkce: true,
    },
    capabilities: ["video.upload", "captions.upload", "video.status", "video.visibility"],
    capabilityScopes: {
      "video.upload": [SCOPE.upload, SCOPE.full, SCOPE.forceSsl],
      "captions.upload": [SCOPE.forceSsl, SCOPE.full],
      "video.status": [SCOPE.readonly, SCOPE.full, SCOPE.forceSsl],
      "video.visibility": [SCOPE.forceSsl, SCOPE.full],
    },
    visibilities: ["private", "unlisted", "public"],
    limits: { title: 100, description: 5000, tags: 500, extensions: Object.keys(CONTENT_TYPES), maxBytes: 256 * 1024 * 1024, captionsExtensions: [".srt", ".vtt", ".sbv"] },
    options,

    validate(input) {
      if (/[<>]/.test(input.title) || /[<>]/.test(input.description)) return "YouTube does not allow < or > in the title or description.";
      const tagChars = input.tags.reduce((sum, tag) => sum + tag.length + (tag.includes(" ") ? 2 : 0), 0) + Math.max(0, input.tags.length - 1);
      if (tagChars > 500) return "YouTube tags must fit in 500 characters in total.";
      return undefined;
    },

    async account(ctx) {
      const response = await call(ctx, `${api}/youtube/v3/channels?part=snippet&mine=true`, { headers: bearer(ctx) }, "Channel lookup failed");
      if (!response.ok) throw await failure(response, "Channel lookup failed");
      const body = (await response.json()) as { items?: { id?: string; snippet?: { title?: string } }[] };
      const item = body.items?.[0];
      if (!item?.id || !item.snippet?.title) throw new ConnectorError("invalid", "This Google account has no YouTube channel");
      return { externalId: item.id, name: item.snippet.title };
    },

    async upload(ctx, input) {
      const o = input.options as Options;
      const snippet = {
        title: input.title,
        description: input.description,
        tags: input.tags,
        ...(o.category_id ? { categoryId: o.category_id } : {}),
        ...(o.language ? { defaultLanguage: o.language, defaultAudioLanguage: o.language } : {}),
      };
      const status = { privacyStatus: input.visibility, containsSyntheticMedia: o.ai_label, selfDeclaredMadeForKids: o.made_for_kids };
      const contentType = CONTENT_TYPES[extname(input.filePath).toLowerCase()] ?? "application/octet-stream";
      const bytes = input.bytes;

      const session = await call(
        ctx,
        `${api}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
        {
          method: "POST",
          headers: { ...bearer(ctx), "content-type": "application/json; charset=UTF-8", "x-upload-content-type": contentType, "x-upload-content-length": String(bytes.byteLength) },
          body: JSON.stringify({ snippet, status }),
        },
        "Starting the upload failed",
      );
      if (!session.ok) throw await failure(session, "Starting the upload failed");
      const location = session.headers.get("location");
      if (!location) throw new ConnectorError("invalid", "YouTube gave no upload session URL");
      const sessionUrl = validateUploadSessionUrl(location, extraOrigins);

      // From here the video may exist even without a clear answer: a lost connection, a timeout or a server error after
      // the bytes were sent is an unknown outcome, never a failure that would allow a second upload.
      let upload: Response;
      try {
        upload = await ctx.fetch(sessionUrl, {
          method: "PUT",
          headers: { ...bearer(ctx), "content-type": contentType, "content-length": String(bytes.byteLength) },
          body: bytes,
          signal: AbortSignal.timeout(uploadTimeoutMs),
        });
      } catch (err) {
        throw new UnknownOutcome(`The upload got no answer from YouTube (${err instanceof Error ? err.message : String(err)}). Check YouTube Studio.`);
      }
      if (upload.status >= 500 || upload.status === 408 || upload.status === 429)
        throw new UnknownOutcome(`YouTube answered HTTP ${upload.status} after receiving the video. Check YouTube Studio.`);
      if (!upload.ok) throw await failure(upload, "The video upload failed");
      const payload = (await upload.json().catch(() => ({}))) as { id?: string };
      if (!payload.id) throw new UnknownOutcome("YouTube's upload answer had no video id. Check YouTube Studio.");
      return { externalId: payload.id, url: `https://youtu.be/${payload.id}` };
    },

    async captions(ctx, input) {
      const boundary = `channel-hub-${Date.now().toString(36)}`;
      const metadata = JSON.stringify({ snippet: { videoId: input.externalId, language: input.language, name: input.name, isDraft: false } });
      const file = await readFile(input.filePath);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
        file,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const response = await call(
        ctx,
        `${api}/upload/youtube/v3/captions?uploadType=multipart&part=snippet`,
        { method: "POST", headers: { ...bearer(ctx), "content-type": `multipart/related; boundary=${boundary}` }, body },
        "Captions upload failed",
      );
      if (!response.ok) throw await failure(response, "Captions upload failed");
      const payload = (await response.json()) as { id?: string };
      if (!payload.id) throw new ConnectorError("invalid", "YouTube's captions answer had no id");
      return { captionId: payload.id };
    },

    async status(ctx, id) {
      const item = await readStatus(ctx, id);
      const s = item.status as { privacyStatus?: Visibility; uploadStatus?: string; rejectionReason?: string; failureReason?: string };
      const detail = s.rejectionReason ?? s.failureReason ?? item.processingDetails?.processingStatus;
      return { ...(s.privacyStatus ? { visibility: s.privacyStatus } : {}), state: s.uploadStatus ?? "unknown", ...(detail ? { detail } : {}), url: `https://youtu.be/${id}` };
    },

    async setVisibility(ctx, id, visibility) {
      // videos.update replaces the whole status part: resend every writable field so labels are not lost.
      const current = (await readStatus(ctx, id)).status as Record<string, unknown>;
      const keep = ["embeddable", "license", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"];
      const status: Record<string, unknown> = { privacyStatus: visibility };
      for (const key of keep) if (current[key] !== undefined) status[key] = current[key];
      if (visibility === "private" && current.publishAt) status.publishAt = current.publishAt;
      const response = await call(
        ctx,
        `${api}/youtube/v3/videos?part=status`,
        { method: "PUT", headers: { ...bearer(ctx), "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ id, status }) },
        "Changing visibility failed",
      );
      if (!response.ok) throw await failure(response, "Changing visibility failed");
    },
  };
}
