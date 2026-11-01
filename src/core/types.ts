import type { z } from "zod";

/** Who may see a post. Every connector maps these to its platform and lists the ones it supports. */
export type Visibility = "private" | "unlisted" | "public";
export const VISIBILITIES = ["private", "unlisted", "public"] as const;

export type Capability = "video.upload" | "captions.upload" | "video.status" | "video.visibility";

/** An app-level secret a connector needs (for example an OAuth client secret). Read from the environment only. */
export type CredentialSpec = { env: string; label: string; secret: boolean };

/** How an account is connected with OAuth 2.0. Core runs the flow; the connector only describes it. */
export type OAuth2Spec = {
  kind: "oauth2";
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra query parameters for the consent page, e.g. { access_type: "offline", prompt: "consent" }. */
  extraParams?: Record<string, string>;
  pkce?: boolean;
};

/** An account connected by pasting a key (the key is stored in the vault). */
export type ApiKeySpec = { kind: "api_key"; label: string };

export type Fetcher = typeof fetch;

/** What a connector gets for one call. It never sees the vault, other accounts or the app that asked. */
export type ConnectorContext = { accessToken: string; fetch: Fetcher };

export type ConnectedAccount = { externalId: string; name: string };

export type UploadInput = {
  /** The real path (symlinks resolved); use it for the file name or type only. Upload `bytes`. */
  filePath: string;
  /** The exact bytes whose SHA-256 is in the ledger. Upload these, never re-read the file. */
  bytes: Buffer<ArrayBuffer>;
  title: string;
  description: string;
  tags: string[];
  visibility: Visibility;
  /** Already checked against the connector's `options` schema. */
  options: Record<string, unknown>;
};

export type CaptionsInput = { externalId: string; filePath: string; language: string; name: string };

export type RemoteStatus = {
  visibility?: Visibility;
  /** Platform's own words, e.g. "processed", "uploaded", "rejected". */
  state: string;
  detail?: string;
  url?: string;
};

export type Limits = { title: number; description: number; tags: number; extensions: string[]; maxBytes: number; captionsExtensions: string[] };

export interface Connector {
  id: string;
  name: string;
  credentials: CredentialSpec[];
  auth: OAuth2Spec | ApiKeySpec;
  capabilities: Capability[];
  /** For OAuth connectors: a capability is granted when the account granted any of these scopes. */
  capabilityScopes?: Partial<Record<Capability, string[]>>;
  visibilities: Visibility[];
  limits: Limits;
  /** Platform-specific publish fields, checked before any platform call. */
  options: z.ZodType<Record<string, unknown>>;
  /** Extra platform rules checked before any platform call. Returns a problem to show the caller, or nothing. */
  validate?(input: Omit<UploadInput, "filePath" | "bytes">): string | undefined;
  account(ctx: ConnectorContext): Promise<ConnectedAccount>;
  upload(ctx: ConnectorContext, input: UploadInput): Promise<{ externalId: string; url: string }>;
  captions?(ctx: ConnectorContext, input: CaptionsInput): Promise<{ captionId: string }>;
  status?(ctx: ConnectorContext, externalId: string): Promise<RemoteStatus>;
  setVisibility?(ctx: ConnectorContext, externalId: string, visibility: Visibility): Promise<void>;
}

/**
 * A failure reported by a platform. `kind` drives what core does next:
 * - authorization: the account must be reconnected;
 * - permission: the account lacks a scope for this action (reconnect to grant it);
 * - quota / transient / invalid / session_expired: the call failed and nothing was published.
 * Any other error thrown during an upload (a dropped connection, for example) means the outcome is unknown.
 */
export type ConnectorErrorKind = "authorization" | "permission" | "quota" | "transient" | "invalid" | "session_expired";

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

/**
 * Throw this when the platform may have received the post but did not confirm it (a server error or timeout after the
 * bytes were sent). Core records the upload as unknown and never retries it by itself.
 */
export class UnknownOutcome extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownOutcome";
  }
}

export type HubErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unsupported"
  | "not_configured"
  | "needs_reconnect"
  | "public_confirm"
  | "outcome_unknown"
  | "busy"
  | "platform_error";

const STATUS: Record<HubErrorCode, number> = {
  invalid_input: 400,
  unsupported: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  needs_reconnect: 409,
  public_confirm: 409,
  outcome_unknown: 409,
  busy: 409,
  platform_error: 502,
  not_configured: 503,
};

/** An error the Hub returns to a caller as `{ code, message }`. Messages never contain secrets. */
export class HubError extends Error {
  readonly status: number;
  constructor(
    readonly code: HubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HubError";
    this.status = STATUS[code];
  }
}
