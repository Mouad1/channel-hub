import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type Cipher = { encrypt(value: string): string; decrypt(value: string): string };

const MIN_KEY_LENGTH = 32;

/** AES-256-GCM with a fresh IV per value. Output: `iv.tag.data`, each base64url. */
export function createCipher(secret: string): Cipher {
  if (!secret || secret.length < MIN_KEY_LENGTH)
    throw new Error(`CHANNEL_HUB_MASTER_KEY must be at least ${MIN_KEY_LENGTH} characters (for example: openssl rand -base64 48).`);
  const key = createHash("sha256").update(secret).digest();
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
    },
    decrypt(value) {
      const [ivText, tagText, dataText] = value.split(".");
      if (!ivText || !tagText || !dataText) throw new Error("Invalid encrypted value");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
      decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}
