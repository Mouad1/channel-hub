import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Store, newAppKey } from "../dist/core/store.js";
import { tempHome } from "./helpers.mjs";

test("app keys are stored as hashes and matched in constant time", () => {
  const home = tempHome();
  try {
    const store = new Store(home.dir);
    const key = newAppKey();
    assert.match(key, /^chub_[A-Za-z0-9_-]{40,}$/);
    store.addApp("my-app", key, ["youtube:UC1"]);
    assert.ok(!readFileSync(join(home.dir, "apps.json"), "utf8").includes(key));
    assert.equal(statSync(join(home.dir, "apps.json")).mode & 0o777, 0o600);
    assert.equal(store.appForKey(key)?.name, "my-app");
    assert.equal(store.appForKey(`${key}x`), undefined);
    assert.equal(store.appForKey(""), undefined);
    assert.throws(() => store.addApp("my-app", newAppKey(), []), /already exists/);
    assert.deepEqual(store.apps().map((a) => [a.name, a.accounts]), [["my-app", ["youtube:UC1"]]]);
    assert.ok(!("keyHash" in store.apps()[0]));
    assert.equal(store.removeApp("my-app"), true);
    assert.equal(store.appForKey(key), undefined);
  } finally {
    home.done();
  }
});

test("accounts upsert by id and keep no secrets", () => {
  const home = tempHome();
  try {
    const store = new Store(home.dir);
    store.upsertAccount({ id: "youtube:UC1", connector: "youtube", externalId: "UC1", name: "One", scopes: ["a"], status: "connected" });
    store.upsertAccount({ id: "youtube:UC1", connector: "youtube", externalId: "UC1", name: "One renamed", scopes: ["a", "b"], status: "connected" });
    assert.deepEqual(store.accounts().map((a) => [a.id, a.name, a.scopes]), [["youtube:UC1", "One renamed", ["a", "b"]]]);
    store.setAccountStatus("youtube:UC1", "needs_reconnect");
    assert.equal(store.account("youtube:UC1")?.status, "needs_reconnect");
  } finally {
    home.done();
  }
});

test("ledger finds the latest record for an account and file hash, and survives a restart", () => {
  const home = tempHome();
  try {
    const store = new Store(home.dir);
    const first = store.addRecord({ app: "a", account: "youtube:UC1", contentHash: "h1", title: "t", visibility: "private" });
    assert.equal(first.state, "requested");
    store.updateRecord(first.id, { state: "failed", error: "boom" });
    const second = store.addRecord({ app: "a", account: "youtube:UC1", contentHash: "h1", title: "t", visibility: "private" });
    const reopened = new Store(home.dir);
    assert.equal(reopened.latestRecord("youtube:UC1", "h1")?.id, second.id);
    assert.equal(reopened.latestRecord("youtube:UC2", "h1"), undefined);
    assert.equal(reopened.record(first.id)?.error, "boom");
  } finally {
    home.done();
  }
});

test("audit appends one JSON line per event", () => {
  const home = tempHome();
  try {
    const store = new Store(home.dir);
    store.audit({ action: "publish_requested", app: "a", account: "youtube:UC1" });
    store.audit({ action: "publish_succeeded", app: "a", account: "youtube:UC1", externalId: "v1" });
    const lines = readFileSync(join(home.dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.action), ["publish_requested", "publish_succeeded"]);
    assert.ok(lines.every((l) => typeof l.at === "string"));
    assert.equal(statSync(join(home.dir, "audit.jsonl")).mode & 0o777, 0o600);
  } finally {
    home.done();
  }
});
