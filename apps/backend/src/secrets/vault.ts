// Server-side vault for customer and company credentials.
//
// One master key lives only in the control-plane environment (ORVYN_VAULT_KEY).
// It is never written into the desktop installer or a tenant database.
// Each secret is sealed with AES-256-GCM. The tenant id and secret name are
// authenticated data, so a ciphertext copied from one customer cannot be
// opened as another customer's secret.
//
// Production refuses to boot on a missing key or the well-known development key.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const PREFIX = "orvyn:v1:";

/** Well-known local key. Production must not use it. */
export const VAULT_DEV_KEY = Buffer.alloc(32, 0x11);

export function isProductionVaultEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORVYN_ENV === "production" || env.ORVYN_CLOUD_MODE === "true" || env.NODE_ENV === "production";
}

export function loadVaultKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = String(env.ORVYN_VAULT_KEY ?? "").trim();
  const production = isProductionVaultEnv(env);
  if (!raw) {
    if (production) {
      throw new Error("ORVYN_VAULT_KEY is required in production. Customer credentials cannot use the development key.");
    }
    return Buffer.from(VAULT_DEV_KEY);
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("ORVYN_VAULT_KEY must be 32 bytes, base64-encoded.");
  }
  if (key.length !== 32) throw new Error("ORVYN_VAULT_KEY must be 32 bytes, base64-encoded.");
  if (production && key.equals(VAULT_DEV_KEY)) {
    throw new Error("Refusing the development vault key in production.");
  }
  return key;
}

/** Bind a secret to one tenant. A copy opened under another tenant id fails. */
export function sealSecret(plain: string, tenantId: string, name: string, key: Buffer = loadVaultKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${tenantId}\0${name}`, "utf8"));
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

/** Returns null when the key, tenant, or name does not match. Legacy plaintext is returned as-is. */
export function openSecret(stored: string, tenantId: string, name: string, key: Buffer = loadVaultKey()): string | null {
  if (!stored.startsWith(PREFIX)) return stored;
  const parts = stored.slice(PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64"));
    decipher.setAAD(Buffer.from(`${tenantId}\0${name}`, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
