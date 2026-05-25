import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY env var is required (64 hex chars = 32 bytes)",
    );
  }
  return Buffer.from(key, "hex");
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a hex string: iv + authTag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  // iv (32 hex) + authTag (32 hex) + ciphertext
  return iv.toString("hex") + authTag.toString("hex") + encrypted;
}

/**
 * Decrypt a hex string produced by `encrypt`.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();

  const iv = Buffer.from(ciphertext.slice(0, IV_LENGTH * 2), "hex");
  const authTag = Buffer.from(
    ciphertext.slice(IV_LENGTH * 2, IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2),
    "hex",
  );
  const encrypted = ciphertext.slice(IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
