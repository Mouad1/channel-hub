import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCipher } from "../dist/core/cipher.js";
import { Vault } from "../dist/core/vault.js";
import { tempHome } from "./helpers.mjs";

test("cipher round trips and refuses tampered or foreign values", () => {
  const cipher = createCipher("a-long-master-key-for-tests-only-0123456789");
  const sealed = cipher.encrypt("refresh-token-value");
  assert.notEqual(sealed, "refresh-token-value");
  assert.equal(cipher.decrypt(sealed), "refresh-token-value");
  const [iv, tag, data] = sealed.split(".");
  assert.throws(() => cipher.decrypt(`${iv}.${tag}.${data.slice(0, -2)}AA`));
  assert.throws(() => createCipher("another-long-master-key-0123456789abcdef").decrypt(sealed));
});

test("cipher refuses a short master key", () => {
  assert.throws(() => createCipher("short"), /CHANNEL_HUB_MASTER_KEY/);
});

test("vault stores secrets encrypted, owner-only, and never leaks them in errors", () => {
  const home = tempHome();
  try {
    const vault = new Vault(home.dir, createCipher("a-long-master-key-for-tests-only-0123456789"));
    vault.put("youtube:UC1", "rt-secret-value");
    const file = join(home.dir, "vault.json");
    assert.ok(!readFileSync(file, "utf8").includes("rt-secret-value"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(vault.get("youtube:UC1"), "rt-secret-value");
    assert.equal(vault.get("youtube:missing"), undefined);

    const wrongKey = new Vault(home.dir, createCipher("another-long-master-key-0123456789abcdef"));
    assert.throws(() => wrongKey.get("youtube:UC1"), (err) => !String(err.message).includes("rt-secret") && /MASTER_KEY/.test(err.message));
    vault.delete("youtube:UC1");
    assert.equal(vault.get("youtube:UC1"), undefined);
  } finally {
    home.done();
  }
});

test("vault survives a corrupt file by refusing to read it, not by wiping it", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home.dir, "vault.json"), "{not json");
    const vault = new Vault(home.dir, createCipher("a-long-master-key-for-tests-only-0123456789"));
    assert.throws(() => vault.get("x"), /vault\.json/);
    assert.throws(() => vault.put("x", "y"), /vault\.json/);
    assert.equal(readFileSync(join(home.dir, "vault.json"), "utf8"), "{not json");
  } finally {
    home.done();
  }
});
