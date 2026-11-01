import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setEnvValues } from "../dist/envfile.js";
import { createRuntime } from "../dist/runtime.js";
import { startServer } from "../dist/server.js";
import { startFakeYouTube } from "./fake-youtube.mjs";
import { tempHome } from "./helpers.mjs";

const run = promisify(execFile);

test("setEnvValues replaces or appends lines and keeps everything else", () => {
  const home = tempHome();
  try {
    const file = join(home.dir, ".env.local");
    writeFileSync(file, "# app settings\nDATABASE_URL=postgres://x\nCHANNEL_HUB_KEY=old\n");
    setEnvValues(file, { CHANNEL_HUB_KEY: "chub_new", CHANNEL_HUB_URL: "http://127.0.0.1:8790" });
    assert.equal(readFileSync(file, "utf8"), "# app settings\nDATABASE_URL=postgres://x\nCHANNEL_HUB_KEY=chub_new\nCHANNEL_HUB_URL=http://127.0.0.1:8790\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const fresh = join(home.dir, "new", ".env.local");
    setEnvValues(fresh, { A: "1" });
    assert.equal(readFileSync(fresh, "utf8"), "A=1\n");
    assert.throws(() => setEnvValues(join(home.dir, "notes.txt"), { A: "1" }), /\.local/);
    assert.throws(() => setEnvValues(join(home.dir, ".env"), { A: "1" }), /\.local/);
    assert.throws(() => setEnvValues(join(home.dir, ".env.example"), { A: "1" }), /\.local/);
  } finally {
    home.done();
  }
});

test("CLI: doctor, accounts and apps add --write-env never print secrets", async () => {
  const home = tempHome();
  const fake = await startFakeYouTube();
  const env = {
    CHANNEL_HUB_HOME: home.dir,
    CHANNEL_HUB_PORT: "0",
    CHANNEL_HUB_MASTER_KEY: "a-long-master-key-for-tests-only-0123456789",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    CHANNEL_HUB_TEST_GOOGLE_BASE_URL: fake.base,
  };
  const rt = createRuntime(env);
  const running = await startServer(rt.hub, { home: rt.home, port: 0, onListen: rt.setPort });
  const cliEnv = { ...process.env, ...env, CHANNEL_HUB_PORT: String(running.port) };
  const cli = (...args) => run(process.execPath, ["dist/cli.js", ...args], { env: cliEnv });
  try {
    const state = new URL(rt.hub.startConnect("youtube").url).searchParams.get("state");
    await rt.hub.finishConnect("youtube", state, "good-code");

    const doctor = await cli("doctor");
    assert.match(doctor.stdout, /CHANNEL_HUB_MASTER_KEY\s+set/);
    assert.match(doctor.stdout, /youtube.*ready/i);
    assert.match(doctor.stdout, /running/);
    assert.match(doctor.stdout, /TEST_GOOGLE_BASE_URL/);
    assert.ok(!doctor.stdout.includes("test-client-secret") && !doctor.stdout.includes("a-long-master-key"));

    assert.match((await cli("accounts")).stdout, /youtube:UCfake\s+Fake Channel\s+connected/);

    const target = join(home.dir, "app", ".env.local");
    const added = await cli("apps", "add", "my-app", "--accounts", "youtube:UCfake", "--write-env", target);
    const written = readFileSync(target, "utf8");
    const key = written.match(/CHANNEL_HUB_KEY=(chub_\S+)/)[1];
    assert.ok(!added.stdout.includes(key) && !added.stderr.includes(key));
    assert.match(written, new RegExp(`CHANNEL_HUB_URL=http://127.0.0.1:${running.port}`));
    assert.equal(rt.hub.appForKey(key).name, "my-app");

    await assert.rejects(cli("apps", "add", "other", "--accounts", "youtube:UCfake"), /--write-env/);
    assert.match((await cli("apps", "list")).stdout, /my-app\s+youtube:UCfake/);
    await cli("apps", "remove", "my-app");
    assert.equal(rt.hub.appForKey(key), undefined);

    const connect = await cli("connect", "youtube", "--no-open");
    assert.match(connect.stdout, /\/o\/oauth2\/v2\/auth\?/);
  } finally {
    await running.close();
    await fake.close();
    home.done();
  }
});

test("CLI tells the owner when the Hub is not running", async () => {
  const home = tempHome();
  try {
    const env = { ...process.env, CHANNEL_HUB_HOME: home.dir, CHANNEL_HUB_PORT: "1" };
    await assert.rejects(run(process.execPath, ["dist/cli.js", "accounts"], { env }), /channel-hub start/);
  } finally {
    home.done();
  }
});
