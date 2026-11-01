import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { createRuntime } from "../dist/runtime.js";
import { startServer } from "../dist/server.js";
import { ChannelHubClient } from "../dist/client.js";
import { startFakeYouTube } from "./fake-youtube.mjs";
import { tempHome } from "./helpers.mjs";

async function setup() {
  const home = tempHome();
  const fake = await startFakeYouTube();
  const rt = createRuntime({
    CHANNEL_HUB_HOME: home.dir,
    CHANNEL_HUB_PORT: "0",
    CHANNEL_HUB_MASTER_KEY: "a-long-master-key-for-tests-only-0123456789",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    CHANNEL_HUB_TEST_GOOGLE_BASE_URL: fake.base,
  });
  const running = await startServer(rt.hub, { home: rt.home, port: 0, onListen: rt.setPort });
  assert.equal(running.role, "owner");
  const base = `http://127.0.0.1:${running.port}`;
  const admin = JSON.parse(readFileSync(join(home.dir, "admin-token.json"), "utf8")).token;
  const req = (method, path, { body, headers = {} } = {}) =>
    fetch(`${base}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const asAdmin = (method, path, body) => req(method, path, { body, headers: { "x-channel-hub-admin": admin } });
  const video = join(home.dir, "short.mp4");
  writeFileSync(video, "mp4-bytes");
  const done = async () => {
    await rt.hub.idle();
    await running.close();
    await fake.close();
    home.done();
  };
  return { home, fake, rt, base, req, asAdmin, video, done };
}

async function connected(t) {
  const { url } = await (await t.asAdmin("POST", "/admin/connect/youtube")).json();
  const state = new URL(url).searchParams.get("state");
  const callback = await t.req("GET", `/oauth/callback/youtube?state=${state}&code=good-code`);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /Fake Channel/);
  const created = await t.asAdmin("POST", "/admin/apps", { name: "my-app", accounts: ["youtube:UCfake"] });
  assert.equal(created.status, 201);
  const { key } = await created.json();
  return key;
}

test("health is open; everything else needs the right host, and a key or admin token", async () => {
  const t = await setup();
  try {
    assert.deepEqual(await (await t.req("GET", "/health")).json(), { name: "channel-hub" });
    assert.equal((await t.req("GET", "/v1/accounts")).status, 401);
    assert.equal((await t.req("GET", "/v1/accounts", { headers: { "x-channel-hub-key": "chub_wrong" } })).status, 401);
    assert.equal((await t.req("GET", "/admin/apps", { headers: { "x-channel-hub-admin": "wrong" } })).status, 401);
    // fetch() cannot set Host; a DNS-rebinding page would arrive with its own host name.
    const rebound = await new Promise((ok, fail) => request(`${t.base}/health`, { headers: { host: "evil.example" } }, (r) => ok(r.statusCode)).on("error", fail).end());
    assert.equal(rebound, 403);
    const key = await connected(t);
    assert.equal((await t.req("GET", "/v1/accounts", { headers: { "x-channel-hub-key": key, origin: "https://evil.example" } })).status, 403);
    assert.equal((await t.req("GET", "/v1/accounts", { headers: { authorization: `Bearer ${key}` } })).status, 200);
    assert.equal((await t.req("GET", "/admin/apps", { headers: { "x-channel-hub-key": key } })).status, 401, "an app key is not an admin token");
  } finally {
    await t.done();
  }
});

test("a reused or unknown OAuth state is refused", async () => {
  const t = await setup();
  try {
    const { url } = await (await t.asAdmin("POST", "/admin/connect/youtube")).json();
    const state = new URL(url).searchParams.get("state");
    assert.equal((await t.req("GET", `/oauth/callback/youtube?state=${state}&code=good-code`)).status, 200);
    assert.equal((await t.req("GET", `/oauth/callback/youtube?state=${state}&code=good-code`)).status, 400);
    assert.equal((await t.req("GET", `/oauth/callback/youtube?state=made-up&code=good-code`)).status, 400);
    assert.equal((await t.req("GET", `/oauth/callback/youtube?error=access_denied`)).status, 400);
  } finally {
    await t.done();
  }
});

test("no route returns a token, refresh token or key hash", async () => {
  const t = await setup();
  try {
    await connected(t);
    const bodies = await Promise.all(["/admin/accounts", "/admin/apps", "/admin/connectors"].map(async (p) => (await t.asAdmin("GET", p)).text()));
    for (const body of bodies) {
      assert.ok(!body.includes("rt-fake") && !body.includes("at-") && !body.includes("keyHash") && !body.includes("test-client-secret"), body);
    }
    const vault = readFileSync(join(t.home.dir, "vault.json"), "utf8");
    assert.ok(!vault.includes("rt-fake"));
  } finally {
    await t.done();
  }
});

test("an app publishes, polls, changes visibility and reads status through the client", async () => {
  const t = await setup();
  try {
    const key = await connected(t);
    const hub = new ChannelHubClient({ url: t.base, key });
    assert.deepEqual((await hub.accounts()).accounts.map((a) => a.id), ["youtube:UCfake"]);
    const started = await hub.publish({ account: "youtube:UCfake", file_path: t.video, title: "Hello", options: { made_for_kids: false, ai_label: true } });
    assert.equal(started.state, "uploading");
    await t.rt.hub.idle();
    const done = await hub.publishStatus(started.publish_id);
    assert.equal(done.state, "published");
    const again = await hub.publish({ account: "youtube:UCfake", file_path: t.video, title: "Hello", options: { made_for_kids: false, ai_label: true } });
    assert.equal(again.already_published, true);
    await assert.rejects(hub.setVisibility("youtube:UCfake", done.external_id, "public"), (e) => e.code === "public_confirm" && e.status === 409);
    assert.equal((await hub.setVisibility("youtube:UCfake", done.external_id, "public", true)).visibility, "public");
    assert.equal((await hub.postStatus("youtube:UCfake", done.external_id)).visibility, "public");
    await assert.rejects(hub.publish({ account: "youtube:UCfake", file_path: t.video, title: "x" }), (e) => e.code === "invalid_input" && e.status === 400);
  } finally {
    await t.done();
  }
});

test("bad JSON and huge bodies are refused", async () => {
  const t = await setup();
  try {
    const key = await connected(t);
    const bad = await fetch(`${t.base}/v1/publish`, { method: "POST", headers: { "x-channel-hub-key": key, "content-type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${t.base}/v1/publish/%E0%A4%A`, { headers: { "x-channel-hub-key": key } })).status, 400);
    const huge = await fetch(`${t.base}/v1/publish`, { method: "POST", headers: { "x-channel-hub-key": key, "content-type": "application/json" }, body: JSON.stringify({ title: "x".repeat(70000) }) });
    assert.equal(huge.status, 400);
  } finally {
    await t.done();
  }
});

test("apps can be listed, re-scoped and removed by the owner", async () => {
  const t = await setup();
  try {
    const key = await connected(t);
    assert.deepEqual((await (await t.asAdmin("GET", "/admin/apps")).json()).apps.map((a) => a.name), ["my-app"]);
    assert.equal((await t.asAdmin("PUT", "/admin/apps/my-app/accounts", { accounts: [] })).status, 200);
    assert.deepEqual((await (await t.req("GET", "/v1/accounts", { headers: { "x-channel-hub-key": key } })).json()).accounts, []);
    assert.equal((await t.asAdmin("DELETE", "/admin/apps/my-app")).status, 200);
    assert.equal((await t.req("GET", "/v1/accounts", { headers: { "x-channel-hub-key": key } })).status, 401);
  } finally {
    await t.done();
  }
});
