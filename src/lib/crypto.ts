// src/lib/crypto.ts
import crypto from "crypto";

type EncryptedJSON = {
  v: 1;
  iv: string;   // base64
  tag: string;  // base64
  ct: string;   // base64
};

// 32-byte key, base64-encoded in env
const RAW_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, "base64")
  : null;

function assertKey() {
  if (!RAW_KEY || RAW_KEY.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must be set to a base64-encoded 32-byte key (use: openssl rand -base64 32)"
    );
  }
}

export function encryptJSON(obj: unknown): string {
  assertKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", RAW_KEY!, iv);
  const pt = Buffer.from(JSON.stringify(obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedJSON = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
  return JSON.stringify(payload);
}

export function decryptJSON<T = any>(enc: string): T {
  assertKey();
  const payload = JSON.parse(enc) as EncryptedJSON;
  if (!payload || payload.v !== 1) throw new Error("Bad ciphertext format");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ct = Buffer.from(payload.ct, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", RAW_KEY!, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}
