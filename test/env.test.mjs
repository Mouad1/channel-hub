import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../dist/env.js";

test("empty CHANNEL_HUB_HOME and CHANNEL_HUB_PORT fall back to the defaults", () => {
  const { home, port } = loadEnv({ CHANNEL_HUB_HOME: "", CHANNEL_HUB_PORT: "" });
  assert.equal(home, join(homedir(), ".channel-hub"));
  assert.equal(port, 8790);
});

test("a set CHANNEL_HUB_PORT is used; nonsense is refused", () => {
  assert.equal(loadEnv({ CHANNEL_HUB_HOME: "/tmp/x", CHANNEL_HUB_PORT: "9000" }).port, 9000);
  assert.throws(() => loadEnv({ CHANNEL_HUB_HOME: "/tmp/x", CHANNEL_HUB_PORT: "abc" }), /CHANNEL_HUB_PORT/);
});
