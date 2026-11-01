import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRuntime } from "../dist/runtime.js";
import { startFakeYouTube } from "./fake-youtube.mjs";
import { tempHome } from "./helpers.mjs";

const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

test("an assistant lists accounts, uploads, polls and changes visibility through the MCP tools", async () => {
  const home = tempHome();
  const fake = await startFakeYouTube();
  const port = await freePort();
  const env = {
    CHANNEL_HUB_HOME: home.dir,
    CHANNEL_HUB_PORT: String(port),
    CHANNEL_HUB_MASTER_KEY: "a-long-master-key-for-tests-only-0123456789",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    CHANNEL_HUB_TEST_GOOGLE_BASE_URL: fake.base,
  };
  // Owner set-up, done once: connect the channel and give the assistant a key.
  const setup = createRuntime(env);
  const state = new URL(setup.hub.startConnect("youtube").url).searchParams.get("state");
  await setup.hub.finishConnect("youtube", state, "good-code");
  const { key } = setup.hub.addApp("assistant", ["youtube:UCfake"]);
  const video = join(home.dir, "short.mp4");
  writeFileSync(video, "mp4-bytes");
  const srt = join(home.dir, "short.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nHi\n");

  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/mcp.js"], env: { ...process.env, ...env, CHANNEL_HUB_KEY: key }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, body: JSON.parse(result.content[0].text) };
  };
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["accounts_list", "captions_upload", "video_status", "video_update", "video_upload"]);

    const accounts = await call("accounts_list");
    assert.deepEqual(accounts.body.accounts.map((a) => a.id), ["youtube:UCfake"]);

    const refused = await call("video_upload", { account: "youtube:UCfake", file_path: video, title: "Hi", visibility: "public", options: { made_for_kids: false, ai_label: true } });
    assert.equal(refused.error, true);
    assert.equal(refused.body.error, "public_confirm");

    const started = await call("video_upload", { account: "youtube:UCfake", file_path: video, title: "Hi", options: { made_for_kids: false, ai_label: true, language: "en" }, captions: { file_path: srt, language: "en" } });
    assert.equal(started.error, false);
    let status;
    for (let i = 0; i < 50; i++) {
      status = (await call("video_status", { publish_id: started.body.publish_id })).body;
      if (status.state !== "uploading" || status.captions) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(status.state, "published");
    assert.equal(fake.videos.get(status.external_id).status.privacyStatus, "private");

    const again = await call("video_upload", { account: "youtube:UCfake", file_path: video, title: "Hi", options: { made_for_kids: false, ai_label: true } });
    assert.equal(again.body.already_published, true);

    assert.equal((await call("video_update", { account: "youtube:UCfake", external_id: status.external_id, visibility: "public" })).body.error, "public_confirm");
    assert.equal((await call("video_update", { account: "youtube:UCfake", external_id: status.external_id, visibility: "unlisted" })).body.visibility, "unlisted");
    assert.equal((await call("video_status", { account: "youtube:UCfake", external_id: status.external_id })).body.visibility, "unlisted");
    assert.ok((await call("captions_upload", { account: "youtube:UCfake", external_id: status.external_id, file_path: srt, language: "en" })).body.caption_id);
    assert.equal((await call("video_status", {})).error, true);
  } finally {
    await client.close();
    await fake.close();
    home.done();
  }
});
