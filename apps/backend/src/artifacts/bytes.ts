import { createHash } from "crypto";

export const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from("%PDF");
const ZIP = Buffer.from([0x50, 0x4b]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF = Buffer.from("GIF8");
const WEBP = Buffer.from("WEBP");

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertNonEmpty(bytes: Buffer): void {
  if (!bytes || bytes.length === 0) throw new Error("Rejected zero-byte artifact.");
}

export function assertSizeLimit(bytes: Buffer): void {
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB limit.`);
  }
}

/** Best-effort magic-byte check. Returns the validated MIME or throws on contradiction. */
export function validateBytes(name: string, declaredMime: string, bytes: Buffer): string {
  assertNonEmpty(bytes);
  assertSizeLimit(bytes);
  const ext = name.toLowerCase().replace(/^.*(\.[a-z0-9]+)$/, "$1");
  if (ext === ".png" || declaredMime === "image/png") {
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG)) throw new Error("Declared PNG is not a PNG (bad file signature).");
    return "image/png";
  }
  if (ext === ".pdf" || declaredMime === "application/pdf") {
    if (!bytes.subarray(0, 4).equals(PDF)) throw new Error("Declared PDF is not a PDF (bad file signature).");
    return "application/pdf";
  }
  if (ext === ".zip" || declaredMime === "application/zip") {
    if (!bytes.subarray(0, 2).equals(ZIP)) throw new Error("Declared ZIP is not a ZIP (bad file signature).");
    return "application/zip";
  }
  if (ext === ".jpg" || ext === ".jpeg" || declaredMime === "image/jpeg") {
    if (!bytes.subarray(0, 3).equals(JPEG)) throw new Error("Declared JPEG is not a JPEG (bad file signature).");
    return "image/jpeg";
  }
  if (ext === ".gif" || declaredMime === "image/gif") {
    if (!bytes.subarray(0, 4).equals(GIF)) throw new Error("Declared GIF is not a GIF (bad file signature).");
    return "image/gif";
  }
  if (ext === ".webp" || declaredMime === "image/webp") {
    if (bytes.length < 12 || !bytes.subarray(8, 12).equals(WEBP)) throw new Error("Declared WebP is not a WebP (bad file signature).");
    return "image/webp";
  }
  return declaredMime || "application/octet-stream";
}

export function isPreviewable(mime: string): boolean {
  return mime.startsWith("image/") || mime.startsWith("text/") || mime === "application/pdf" || mime === "application/json" || mime === "image/svg+xml";
}

/** 1×1 transparent PNG with a valid 8-byte signature. */
export const MINIMAL_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex"
);
