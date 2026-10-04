// apps/backend/src/persistence/modelSecret.ts
//
// Encryption for persisted tenant model credentials.
//
// Cloud/PostgreSQL mode centralizes tenant-added model configs, so provider API
// keys must not be stored as plaintext JSON. AES-256-GCM provides authenticated
// encryption with a fresh random IV per value.
//
// ORVYN_MODEL_SECRET_KEY accepts:
// - 64 hex characters (32 bytes), or
// - base64 encoding of exactly 32 bytes.
//
// Local-only installs without the key remain backward compatible: LocalStore
// may keep plaintext config as before. PostgreSQL persistence requires the key
// whenever a model config contains apiKey.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import type { ModelConfig } from "@orvyn/ai-core";

const PREFIX = "orvynenc:v1";

function parseKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }

  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export function modelSecretKeyConfigured(): boolean {
  return parseKey(process.env.ORVYN_MODEL_SECRET_KEY) !== null;
}

export function requireModelSecretKey(): Buffer {
  const key = parseKey(process.env.ORVYN_MODEL_SECRET_KEY);
  if (!key) {
    throw new Error(
      "ORVYN_MODEL_SECRET_KEY must be a 32-byte key (64 hex chars or base64) before persisting tenant model credentials to PostgreSQL"
    );
  }
  return key;
}

export function encryptSecret(value: string, key = requireModelSecretKey()): string {
  if (!value || value.startsWith(`${PREFIX}:`)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptSecret(value: string, key = requireModelSecretKey()): string {
  if (!value?.startsWith(`${PREFIX}:`)) return value;
  const parts = value.split(":");
  if (
    parts.length !== 5 ||
    parts[0] !== "orvynenc" ||
    parts[1] !== "v1"
  ) {
    throw new Error("Invalid encrypted model secret format");
  }
  const iv = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  const encrypted = Buffer.from(parts[4], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptModelConfig(config: ModelConfig): ModelConfig {
  if (!config.apiKey) return { ...config };
  return {
    ...config,
    apiKey: encryptSecret(config.apiKey),
  };
}

export function decryptModelConfig(config: ModelConfig): ModelConfig {
  if (!config.apiKey) return { ...config };
  return {
    ...config,
    apiKey: decryptSecret(config.apiKey),
  };
}

export function isEncryptedModelSecret(value: string | undefined): boolean {
  return Boolean(value?.startsWith(`${PREFIX}:`));
}
