import { test } from "node:test";
import assert from "node:assert/strict";
import { OAuth2 } from "../dist/core/oauth2.js";

const spec = {
  kind: "oauth2",
  authorizeUrl: "https://auth.example/authorize",
  tokenUrl: "https://auth.example/token",
  scopes: ["s.upload", "s.read"],
  clientIdEnv: "X_CLIENT_ID",
  clientSecretEnv: "X_CLIENT_SECRET",
  extraParams: { access_type: "offline", prompt: "consent" },
  pkce: true,
};
const env = { X_CLIENT_ID: "cid", X_CLIENT_SECRET: "csecret" };

function tokenServer(answer) {
  const seen = [];
  const fetch = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    seen.push({ url: String(url), form });
    const [status, body] = answer(form);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, seen };
}

test("start builds a consent URL with a single-use state and PKCE", () => {
  const oauth = new OAuth2(tokenServer(() => [200, {}]).fetch);
  const url = new URL(oauth.start("x", spec, env, "http://127.0.0.1:8790/oauth/callback/x"));
  assert.equal(url.origin + url.pathname, "https://auth.example/authorize");
  const q = url.searchParams;
  assert.equal(q.get("client_id"), "cid");
  assert.equal(q.get("scope"), "s.upload s.read");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.ok(q.get("code_challenge"));
  assert.ok(!url.toString().includes("csecret"));
  const state = q.get("state");
  assert.ok(oauth.consume(state, "x"));
  assert.equal(oauth.consume(state, "x"), undefined, "state works once");
});

test("state is bound to its connector and expires", () => {
  let now = 0;
  const oauth = new OAuth2(tokenServer(() => [200, {}]).fetch, { ttlMs: 1000, now: () => now });
  const a = new URL(oauth.start("x", spec, env, "r")).searchParams.get("state");
  assert.equal(oauth.consume(a, "other"), undefined);
  const b = new URL(oauth.start("x", spec, env, "r")).searchParams.get("state");
  now = 2000;
  assert.equal(oauth.consume(b, "x"), undefined);
});

test("start refuses when client credentials are missing", () => {
  const oauth = new OAuth2(tokenServer(() => [200, {}]).fetch);
  assert.throws(() => oauth.start("x", spec, {}, "r"), (err) => err.code === "not_configured" && /X_CLIENT_ID/.test(err.message));
});

test("exchange returns tokens and granted scopes; a missing refresh token is refused", async () => {
  const server = tokenServer((form) =>
    form.code === "good" ? [200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "s.upload" }] : [200, { access_token: "at" }],
  );
  const oauth = new OAuth2(server.fetch);
  const tokens = await oauth.exchange(spec, env, "good", "r", "verifier");
  assert.deepEqual(tokens, { accessToken: "at", refreshToken: "rt", expiresIn: 3600, scopes: ["s.upload"] });
  assert.equal(server.seen[0].form.code_verifier, "verifier");
  assert.equal(server.seen[0].form.grant_type, "authorization_code");
  await assert.rejects(oauth.exchange(spec, env, "nofresh", "r"), /refresh token/i);
});

test("refresh maps invalid_grant to needs_reconnect and never echoes the token", async () => {
  const server = tokenServer((form) => (form.refresh_token === "revoked-secret" ? [400, { error: "invalid_grant" }] : [200, { access_token: "at2", expires_in: 60 }]));
  const oauth = new OAuth2(server.fetch);
  assert.deepEqual(await oauth.refresh(spec, env, "rt"), { accessToken: "at2", expiresIn: 60 });
  await assert.rejects(oauth.refresh(spec, env, "revoked-secret"), (err) => err.code === "needs_reconnect" && !err.message.includes("revoked-secret"));
});
