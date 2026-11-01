import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Hub } from "../dist/core/hub.js";
import { fakeConnector } from "./fake-connector.mjs";
import { tempHome } from "./helpers.mjs";

const MASTER = "a-long-master-key-for-tests-only-0123456789";

async function setup() {
  const home = tempHome();
  const fake = fakeConnector();
  const hub = new Hub({ home: home.dir, env: { CHANNEL_HUB_MASTER_KEY: MASTER }, connectors: [fake.connector], baseUrl: () => "http://127.0.0.1:1" });
  const account = await hub.connectWithKey("fake", "k1");
  const { key } = hub.addApp("app1", [account.id]);
  const app = hub.appForKey(key);
  const video = join(home.dir, "film.mp4");
  writeFileSync(video, "video-bytes");
  const srt = join(home.dir, "film.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
  const input = (extra = {}) => ({ account: account.id, file_path: video, title: "Title", ...extra });
  return { home, fake, hub, account, app, video, srt, input };
}

const codeOf = (code) => (err) => err.code === code;

test("connect with a key stores it in the vault only, and the account in accounts.json", async () => {
  const t = await setup();
  try {
    assert.equal(t.account.id, "fake:alpha");
    assert.ok(!readFileSync(join(t.home.dir, "accounts.json"), "utf8").includes("k1"));
    assert.ok(!readFileSync(join(t.home.dir, "vault.json"), "utf8").includes("\"k1\""));
    assert.deepEqual(t.hub.accountsFor(t.app).map((a) => [a.id, a.status, a.capabilities.length]), [["fake:alpha", "connected", 4]]);
    await assert.rejects(t.hub.connectWithKey("fake", "bad"), codeOf("needs_reconnect"));
  } finally {
    t.home.done();
  }
});

test("publish defaults to private and passes options through", async () => {
  const t = await setup();
  try {
    const started = await t.hub.publish(t.app, t.input({ options: { note: "hi" } }));
    assert.equal(started.state, "uploading");
    await t.hub.idle();
    const upload = t.fake.calls.find((c) => c[0] === "upload");
    assert.equal(upload[1], "k1");
    assert.equal(upload[2].visibility, "private");
    assert.deepEqual(upload[2].options, { note: "hi" });
    const done = t.hub.publishStatus(t.app, started.publish_id);
    assert.equal(done.state, "published");
    assert.equal(done.url, "https://fake.example/v1");
  } finally {
    t.home.done();
  }
});

test("public needs confirm_public; unsupported visibility is refused", async () => {
  const t = await setup();
  try {
    await assert.rejects(t.hub.publish(t.app, t.input({ visibility: "public" })), codeOf("public_confirm"));
    await assert.rejects(t.hub.publish(t.app, t.input({ visibility: "unlisted" })), codeOf("unsupported"));
    assert.equal(t.fake.calls.filter((c) => c[0] === "upload").length, 0);
    await t.hub.publish(t.app, t.input({ visibility: "public", confirm_public: true }));
    await t.hub.idle();
    assert.equal(t.fake.calls.find((c) => c[0] === "upload")[2].visibility, "public");
  } finally {
    t.home.done();
  }
});

test("input is checked against connector limits, options schema and file rules before any platform call", async () => {
  const t = await setup();
  try {
    await assert.rejects(t.hub.publish(t.app, t.input({ title: "x".repeat(51) })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ options: { note: "far too long here" } })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ options: { other: 1 } })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ file_path: join(t.home.dir, "missing.mp4") })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ file_path: t.srt })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ file_path: "relative.mp4" })), codeOf("invalid_input"));
    const big = join(t.home.dir, "big.mp4");
    writeFileSync(big, Buffer.alloc(2048));
    await assert.rejects(t.hub.publish(t.app, t.input({ file_path: big })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ captions: { file_path: t.video, language: "en" } })), codeOf("invalid_input"));
    assert.equal(t.fake.calls.filter((c) => c[0] === "upload").length, 0);
  } finally {
    t.home.done();
  }
});

test("an app may only use its own accounts", async () => {
  const t = await setup();
  try {
    const other = await t.hub.connectWithKey("fake", "k2");
    await assert.rejects(t.hub.publish(t.app, t.input({ account: other.id })), codeOf("forbidden"));
    await assert.rejects(t.hub.publish(t.app, t.input({ account: "fake:nobody" })), codeOf("forbidden"));
    assert.deepEqual(t.hub.accountsFor(t.app).map((a) => a.id), [t.account.id]);
  } finally {
    t.home.done();
  }
});

test("one upload per file per account: a finished upload returns its link", async () => {
  const t = await setup();
  try {
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    const again = await t.hub.publish(t.app, t.input({ title: "Different title" }));
    assert.equal(again.state, "published");
    assert.equal(again.already_published, true);
    assert.equal(again.publish_id, first.publish_id);
    assert.equal(again.url, "https://fake.example/v1");
    assert.equal(t.fake.calls.filter((c) => c[0] === "upload").length, 1);
  } finally {
    t.home.done();
  }
});

test("same file while uploading is busy", async () => {
  const t = await setup();
  try {
    let release;
    t.fake.script.upload.push(new Promise((r) => (release = r)));
    await t.hub.publish(t.app, t.input());
    await assert.rejects(t.hub.publish(t.app, t.input()), codeOf("busy"));
    await assert.rejects(t.hub.publish(t.app, t.input({ retry_unknown: true })), codeOf("busy"));
    release();
    await t.hub.idle();
  } finally {
    t.home.done();
  }
});

test("a clear platform failure can be retried; nothing is retried automatically", async () => {
  const t = await setup();
  try {
    t.fake.script.upload.push("fail");
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    const failed = t.hub.publishStatus(t.app, first.publish_id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /refused/);
    assert.equal(t.fake.calls.filter((c) => c[0] === "upload").length, 1);
    const second = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, second.publish_id).state, "published");
  } finally {
    t.home.done();
  }
});

test("a dropped connection mid-upload is unknown, and blocks until the caller confirms nothing arrived", async () => {
  const t = await setup();
  try {
    t.fake.script.upload.push("drop");
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, first.publish_id).state, "unknown");
    await assert.rejects(t.hub.publish(t.app, t.input()), codeOf("outcome_unknown"));
    const retried = await t.hub.publish(t.app, t.input({ retry_unknown: true }));
    await t.hub.idle();
    assert.equal(t.hub.publishStatus(t.app, retried.publish_id).state, "published");
    assert.equal(t.hub.publishStatus(t.app, first.publish_id).state, "abandoned");
  } finally {
    t.home.done();
  }
});

test("a Hub that stopped mid-upload reports unknown after restart", async () => {
  const t = await setup();
  try {
    t.fake.script.upload.push(new Promise(() => {}));
    const first = await t.hub.publish(t.app, t.input());
    const restarted = new Hub({ home: t.home.dir, env: { CHANNEL_HUB_MASTER_KEY: MASTER }, connectors: [t.fake.connector], baseUrl: () => "x" });
    const app = t.app;
    assert.equal(restarted.publishStatus(app, first.publish_id).state, "unknown");
    await assert.rejects(restarted.publish(app, t.input()), codeOf("outcome_unknown"));
  } finally {
    t.home.done();
  }
});

test("captions failure never undoes the post, and captions can be retried", async () => {
  const t = await setup();
  try {
    t.fake.script.captions.push("permission");
    const first = await t.hub.publish(t.app, t.input({ captions: { file_path: t.srt, language: "en" } }));
    await t.hub.idle();
    const view = t.hub.publishStatus(t.app, first.publish_id);
    assert.equal(view.state, "published");
    assert.equal(view.captions, "needs-permission");
    const retry = await t.hub.captions(t.app, t.account.id, view.external_id, { file_path: t.srt, language: "en", name: "English" });
    assert.deepEqual(retry, { caption_id: "c-v1" });
    t.fake.script.captions.push("fail");
    await assert.rejects(t.hub.captions(t.app, t.account.id, view.external_id, { file_path: t.srt, language: "en" }), codeOf("platform_error"));
  } finally {
    t.home.done();
  }
});

test("visibility change needs confirm for public; status reads the platform", async () => {
  const t = await setup();
  try {
    await assert.rejects(t.hub.setVisibility(t.app, t.account.id, "v9", { visibility: "public" }), codeOf("public_confirm"));
    await t.hub.setVisibility(t.app, t.account.id, "v9", { visibility: "public", confirm_public: true });
    assert.deepEqual(t.fake.calls.at(-1), ["setVisibility", "v9", "public"]);
    assert.equal((await t.hub.remoteStatus(t.app, t.account.id, "v9")).state, "processed");
  } finally {
    t.home.done();
  }
});

test("publish records belong to the account's apps only", async () => {
  const t = await setup();
  try {
    const first = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    const { key } = t.hub.addApp("app2", []);
    assert.throws(() => t.hub.publishStatus(t.hub.appForKey(key), first.publish_id), codeOf("not_found"));
  } finally {
    t.home.done();
  }
});

test("audit logs every action without secrets", async () => {
  const t = await setup();
  try {
    t.fake.script.captions.push("fail");
    await t.hub.publish(t.app, t.input({ captions: { file_path: t.srt, language: "en" } }));
    await t.hub.idle();
    await t.hub.setVisibility(t.app, t.account.id, "v1", { visibility: "private" });
    const text = readFileSync(join(t.home.dir, "audit.jsonl"), "utf8");
    const actions = text.trim().split("\n").map((l) => JSON.parse(l).action);
    for (const a of ["account_connected", "app_added", "publish_requested", "publish_succeeded", "captions_failed", "visibility_changed"]) assert.ok(actions.includes(a), a);
    assert.ok(!text.includes("k1") && !text.includes("chub_"), "no keys in audit");
  } finally {
    t.home.done();
  }
});

test("missing master key: Hub explains, no crash", async () => {
  const home = tempHome();
  try {
    const hub = new Hub({ home: home.dir, env: {}, connectors: [fakeConnector().connector], baseUrl: () => "x" });
    await assert.rejects(hub.connectWithKey("fake", "k1"), (err) => err.code === "not_configured" && /CHANNEL_HUB_MASTER_KEY/.test(err.message));
  } finally {
    home.done();
  }
});

test("a symlink cannot pass a secret file off as a video or captions file", async () => {
  const t = await setup();
  try {
    const secret = join(t.home.dir, "id_rsa");
    writeFileSync(secret, "PRIVATE KEY");
    symlinkSync(secret, join(t.home.dir, "notes.srt"));
    symlinkSync(secret, join(t.home.dir, "clip.mp4"));
    await assert.rejects(t.hub.publish(t.app, t.input({ file_path: join(t.home.dir, "clip.mp4") })), codeOf("invalid_input"));
    await assert.rejects(t.hub.publish(t.app, t.input({ captions: { file_path: join(t.home.dir, "notes.srt"), language: "en" } })), codeOf("invalid_input"));
    await assert.rejects(t.hub.captions(t.app, t.account.id, "v1", { file_path: join(t.home.dir, "notes.srt"), language: "en" }), codeOf("invalid_input"));
    symlinkSync(t.video, join(t.home.dir, "link.mp4"));
    await t.hub.publish(t.app, t.input({ file_path: join(t.home.dir, "link.mp4") }));
    await t.hub.idle();
  } finally {
    t.home.done();
  }
});

test("the connector uploads exactly the bytes whose hash is in the ledger", async () => {
  const t = await setup();
  try {
    const started = await t.hub.publish(t.app, t.input());
    await t.hub.idle();
    const sent = t.fake.calls.find((c) => c[0] === "upload")[2].bytes;
    const record = t.hub.store.record(started.publish_id);
    assert.equal(createHash("sha256").update(sent).digest("hex"), record.contentHash);
  } finally {
    t.home.done();
  }
});

test("idle can stop waiting after a time limit", async () => {
  const t = await setup();
  try {
    t.fake.script.upload.push(new Promise(() => {}));
    await t.hub.publish(t.app, t.input());
    const before = Date.now();
    assert.equal(await t.hub.idle(100), false);
    assert.ok(Date.now() - before < 1000);
  } finally {
    t.home.done();
  }
});
