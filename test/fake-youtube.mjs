import { createServer } from "node:http";

const SCOPES = {
  upload: "https://www.googleapis.com/auth/youtube.upload",
  readonly: "https://www.googleapis.com/auth/youtube.readonly",
  forceSsl: "https://www.googleapis.com/auth/youtube.force-ssl",
};
export const ALL_SCOPES = Object.values(SCOPES);
export { SCOPES };

/**
 * A local stand-in for Google OAuth and the YouTube Data API: enough of each endpoint the connector uses.
 * Nothing leaves the machine. `fake.next` scripts the next answer of an endpoint; `fake.videos` and `fake.captions`
 * show what was "published".
 */
export async function startFakeYouTube() {
  const fake = {
    base: "",
    grantScopes: [...ALL_SCOPES],
    revoked: new Set(),
    tokens: new Set(),
    videos: new Map(),
    captions: [],
    requests: [],
    /** e.g. fake.next.upload = { status: 403, reason: "quotaExceeded" } | "drop" | "evil-location" */
    next: {},
  };
  let n = 0;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, reason) => send(res, status, { error: { code: status, errors: [{ reason }] } });
  const read = (req) =>
    new Promise((ok) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => ok(Buffer.concat(chunks)));
    });
  const authed = (req) => fake.tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const take = (name) => {
    const step = fake.next[name];
    delete fake.next[name];
    return step;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, fake.base);
    const body = await read(req);
    fake.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

    if (req.method === "POST" && url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(body.toString()));
      if (form.client_id !== "test-client-id" || form.client_secret !== "test-client-secret") return send(res, 401, { error: "invalid_client" });
      const access = `at-${++n}`;
      if (form.grant_type === "authorization_code") {
        if (form.code !== "good-code") return send(res, 400, { error: "invalid_grant" });
        fake.tokens.add(access);
        return send(res, 200, { access_token: access, refresh_token: "rt-fake", expires_in: 3600, scope: fake.grantScopes.join(" ") });
      }
      if (form.grant_type === "refresh_token") {
        if (form.refresh_token !== "rt-fake" || fake.revoked.has(form.refresh_token)) return send(res, 400, { error: "invalid_grant" });
        fake.tokens.add(access);
        return send(res, 200, { access_token: access, expires_in: 3600 });
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }

    if (!authed(req)) return error(res, 401, "authError");

    if (req.method === "GET" && url.pathname === "/youtube/v3/channels") return send(res, 200, { items: [{ id: "UCfake", snippet: { title: "Fake Channel" } }] });

    if (req.method === "POST" && url.pathname === "/upload/youtube/v3/videos") {
      const step = take("session");
      if (step?.status) return error(res, step.status, step.reason);
      const id = `s${++n}`;
      fake.videos.set(`pending-${id}`, { meta: JSON.parse(body.toString()), uploadType: url.searchParams.get("uploadType"), part: url.searchParams.get("part") });
      const location = take("location") === "evil" ? "https://evil.example/upload" : `${fake.base}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}`;
      res.writeHead(200, { location });
      return res.end();
    }
    if (req.method === "PUT" && url.pathname === "/upload/youtube/v3/videos") {
      const step = take("upload");
      if (step === "drop") return req.socket.destroy();
      if (step === "hang") return;
      if (step?.status) return error(res, step.status, step.reason);
      const pending = fake.videos.get(`pending-${url.searchParams.get("upload_id")}`);
      if (!pending) return error(res, 404, "notFound");
      const id = `vid${++n}`;
      fake.videos.set(id, { ...pending.meta, bytes: body.length, contentType: req.headers["content-type"] });
      return send(res, 200, { id, status: { uploadStatus: "uploaded" } });
    }

    if (req.method === "POST" && url.pathname === "/upload/youtube/v3/captions") {
      const step = take("captions");
      if (step?.status) return error(res, step.status, step.reason);
      const text = body.toString();
      const meta = JSON.parse(text.slice(text.indexOf("{"), text.indexOf("}}") + 2));
      fake.captions.push({ ...meta.snippet, body: text });
      return send(res, 200, { id: `cap${++n}` });
    }

    if (req.method === "GET" && url.pathname === "/youtube/v3/videos") {
      const video = fake.videos.get(url.searchParams.get("id"));
      if (!video) return send(res, 200, { items: [] });
      return send(res, 200, { items: [{ id: url.searchParams.get("id"), status: { uploadStatus: "processed", ...video.status }, processingDetails: { processingStatus: "succeeded" } }] });
    }
    if (req.method === "PUT" && url.pathname === "/youtube/v3/videos") {
      const update = JSON.parse(body.toString());
      const video = fake.videos.get(update.id);
      if (!video) return error(res, 404, "videoNotFound");
      fake.lastUpdate = update;
      video.status = update.status;
      return send(res, 200, update);
    }
    error(res, 404, "notFound");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  fake.base = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((ok) => { server.close(ok); server.closeAllConnections(); });
  return fake;
}
