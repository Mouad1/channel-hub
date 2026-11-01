import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub } from "../dist/core/hub.js";
import { youtubeConnector, validateUploadSessionUrl } from "../dist/connectors/youtube/index.js";
import { startFakeYouTube, SCOPES } from "./fake-youtube.mjs";
import { tempHome } from "./helpers.mjs";

const env = { CHANNEL_HUB_MASTER_KEY: "a-long-master-key-for-tests-only-0123456789", GOOGLE_CLIENT_ID: "test-client-id", GOOGLE_CLIENT_SECRET: "test-client-secret" };
const codeOf = (code) => (err) => err.code === code;
const youtubeOptions = { made_for_kids: false, ai_label: true, language: "fr" };

async function setup({ scopes, uploadTimeoutMs } = {}) {
  const home = tempHome();
  const fake = await startFakeYouTube();
  if (scopes) fake.grantScopes = scopes;
  const hub = new Hub({ home: home.dir, env, connectors: [youtubeConnector({ googleBaseUrl: fake.base, ...(uploadTimeoutMs ? { uploadTimeoutMs } : {}) })], baseUrl: () => "http://127.0.0.1:8790" });
  const { url, redirect_uri } = hub.startConnect("youtube");
  const state = new URL(url).searchParams.get("state");
  const account = await hub.finishConnect("youtube", state, "good-code");
  const { key } = hub.addApp("my-app", [account.id]);
  const app = hub.appForKey(key);
  const video = join(home.dir, "short.mp4");
  writeFileSync(video, "mp4-bytes");
  const srt = join(home.dir, "short.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nSalut\n");
  const input = (extra = {}) => ({ account: account.id, file_path: video, title: "Mon short", description: "desc", tags: ["a"], options: youtubeOptions, ...extra });
  const done = async () => {
    await hub.idle();
    await fake.close();
    home.done();
  };
  return { home, fake, hub, account, app, video, srt, input, url, redirect_uri, done };
}

test("connect asks Google for upload, readonly and force-ssl, offline, with consent", async () => {
  const t = await setup();
  try {
    const q = new URL(t.url).searchParams;
    assert.equal(new URL(t.url).pathname, "/o/oauth2/v2/auth");
    assert.deepEqual(q.get("scope").split(" ").sort(), [SCOPES.forceSsl, SCOPES.readonly, SCOPES.upload].sort());
    assert.equal(q.get("access_type"), "offline");
    assert.equal(q.get("prompt"), "consent");
    assert.equal(t.redirect_uri, "http://127.0.0.1:8790/oauth/callback/youtube");
    assert.equal(t.account.id, "youtube:UCfake");
    assert.equal(t.account.name, "Fake Channel");
    assert.deepEqual([...t.account.capabilities].sort(), ["captions.upload", "video.status", "video.upload", "video.visibility"]);
  } finally {
    await t.done();
  }
});

test("upload is private by default and carries the AI label, made-for-kids and language", async () => {
  const t = await setup();
  try {
    const started = await t.hub.publish(t.app, t.input({ captions: { file_path: t.srt, language: "fr", name: "Français" } }));
    await t.hub.idle();
    const view = t.hub.publishStatus(t.app, started.publish_id);
    assert.equal(view.state, "published");
    assert.equal(view.captions, "ok");
    assert.match(view.url, /^https:\/\/youtu\.be\/vid\d+$/);
    const video = t.fake.videos.get(view.external_id);
    assert.equal(video.status.privacyStatus, "private");
    assert.equal(video.status.containsSyntheticMedia, true);
    assert.equal(video.status.selfDeclaredMadeForKids, false);
    assert.equal(video.snippet.defaultLanguage, "fr");
    assert.equal(video.snippet.defaultAudioLanguage, "fr");
    assert.deepEqual(video.snippet.tags, ["a"]);
    assert.equal(video.bytes, "mp4-bytes".length);
    assert.equal(video.contentType, "video/mp4");
    assert.deepEqual(t.fake.captions.map((c) => [c.videoId, c.language, c.name, c.isDraft]), [[view.external_id, "fr", "Français", false]]);
  } finally {
    await t.done();
  }
});

test("made_for_kids and ai_label are required, nothing is sent without them", async () => {
  const t = await setup();
  try {
    await assert.rejects(t.hub.publish(t.app, t.input({ options: { made_for_kids: false } })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ options: { ai_label: true } })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ title: "a <b>" })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ tags: ["x".repeat(100), "y".repeat(100), "z".repeat(100), "w".repeat(100), "v".repeat(100), "u"] })), codeOf("invalid_input"));
    assert.equal(t.fake.requests.filter((r) => r.path.startsWith("/upload")).length, 0);
  } finally {
    await t.done();
  }
});

test("captions 403 insufficientPermissions keeps the video and says needs-permission", async () => {
  const t = await setup();
  try {
    t.fake.next.captions = { status: 403, reason: "insufficientPermissions" };
    const started = await t.hub.publish(t.app, t.input({ captions: { file_path: t.srt, language: "fr" } }));
    await t.hub.idle();
    const view = t.hub.publishStatus(t.app, started.publish_id);
    assert.equal(view.state, "published");
    assert.equal(view.captions, "needs-permission");
  } finally {
    await t.done();
  }
});

test("an account connected without force-ssl cannot do captions: no call, needs-permission", async () => {
  const t = await setup({ scopes: [SCOPES.upload, SCOPES.readonly] });
  try {
    assert.ok(!t.account.capabilities.includes("captions.upload"));
    const started = await t.hub.publish(t.app, t.input({ captions: { file_path: t.srt, language: "fr" } }));
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, started.publish_id).captions, "needs-permission");
    assert.equal(t.fake.captions.length, 0);
    await assert.rejects(t.hub.captions(t.app, t.account.id, "vid1", { file_path: t.srt, language: "fr" }), codeOf("needs_reconnect"));
  } finally {
    await t.done();
  }
});

test("quota refusal is a clear failure; a dropped upload is unknown", async () => {
  const t = await setup();
  try {
    t.fake.next.session = { status: 403, reason: "quotaExceeded" };
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    const failed = t.hub.publishStatus(t.app, first.publish_id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /quota/i);

    t.fake.next.upload = "drop";
    const second = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, second.publish_id).state, "unknown");
    await assert.rejects(t.hub.publish(t.app, t.input()), codeOf("outcome_unknown"));
  } finally {
    await t.done();
  }
});

test("a revoked connection fails the publish and marks the account needs_reconnect", async () => {
  const t = await setup();
  try {
    t.fake.revoked.add("rt-fake");
    t.hub["tokens"].clear();
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, first.publish_id).state, "failed");
    assert.equal(t.hub.accountsFor(t.app)[0].status, "needs_reconnect");
    await assert.rejects(t.hub.publish(t.app, t.input()), codeOf("needs_reconnect"));
  } finally {
    await t.done();
  }
});

test("visibility change keeps the AI label and made-for-kids that videos.update would otherwise drop", async () => {
  const t = await setup();
  try {
    const started = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    const id = t.hub.publishStatus(t.app, started.publish_id).external_id;
    await t.hub.setVisibility(t.app, t.account.id, id, { visibility: "unlisted" });
    assert.deepEqual(t.fake.lastUpdate, { id, status: { privacyStatus: "unlisted", containsSyntheticMedia: true, selfDeclaredMadeForKids: false } });
    const status = await t.hub.remoteStatus(t.app, t.account.id, id);
    assert.equal(status.visibility, "unlisted");
    assert.equal(status.state, "processed");
    await assert.rejects(t.hub.remoteStatus(t.app, t.account.id, "nope"), codeOf("platform_error"));
  } finally {
    await t.done();
  }
});

test("upload session URLs must point at Google (or the configured test base)", async () => {
  assert.throws(() => validateUploadSessionUrl("https://evil.example/upload", []), /session URL/);
  assert.throws(() => validateUploadSessionUrl("http://www.googleapis.com/upload", []), /session URL/);
  assert.equal(validateUploadSessionUrl("https://www.googleapis.com/upload/x", []), "https://www.googleapis.com/upload/x");
  const t = await setup();
  try {
    t.fake.next.location = "evil";
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, first.publish_id).state, "failed");
    assert.ok(!t.fake.requests.some((r) => r.method === "PUT"));
  } finally {
    await t.done();
  }
});

test("a server error after the video bytes were sent is unknown, not failed", async () => {
  const t = await setup();
  try {
    t.fake.next.upload = { status: 503, reason: "backendError" };
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, first.publish_id).state, "unknown");
    await assert.rejects(t.hub.publish(t.app, t.input()), codeOf("outcome_unknown"));
  } finally {
    await t.done();
  }
});

test("an upload that never answers times out as unknown", async () => {
  const t = await setup({ uploadTimeoutMs: 200 });
  try {
    t.fake.next.upload = "hang";
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, first.publish_id).state, "unknown");
  } finally {
    await t.done();
  }
});

test("the test Google base URL is only accepted on this machine", () => {
  assert.throws(() => youtubeConnector({ googleBaseUrl: "https://evil.example" }), /loopback/);
  assert.throws(() => youtubeConnector({ googleBaseUrl: "http://10.0.0.5:9000" }), /loopback/);
  assert.doesNotThrow(() => youtubeConnector({ googleBaseUrl: "http://localhost:9000" }));
});
