import { join } from "node:path";
import type { Cipher } from "./cipher.js";
import { readJson, writeJson } from "./files.js";

/**
 * Account secrets (refresh tokens, API keys), encrypted with the master key, in `vault.json`.
 * Nothing outside core reads it, and no route or tool returns what is in it.
 */
export class Vault {
  private readonly path: string;
  constructor(
    home: string,
    private readonly cipher: Cipher,
  ) {
    this.path = join(home, "vault.json");
  }

  private load(): Record<string, string> {
    return readJson<Record<string, string>>(this.path, {});
  }

  put(accountId: string, secret: string): void {
    const all = this.load();
    all[accountId] = this.cipher.encrypt(secret);
    writeJson(this.path, all);
  }

  get(accountId: string): string | undefined {
    const sealed = this.load()[accountId];
    if (sealed === undefined) return undefined;
    try {
      return this.cipher.decrypt(sealed);
    } catch {
      throw new Error(`The secret for ${accountId} cannot be decrypted. Was CHANNEL_HUB_MASTER_KEY changed? Reconnect the account.`);
    }
  }

  delete(accountId: string): void {
    const all = this.load();
    if (!(accountId in all)) return;
    delete all[accountId];
    writeJson(this.path, all);
  }
}
