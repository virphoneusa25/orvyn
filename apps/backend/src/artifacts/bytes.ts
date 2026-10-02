import { createHash } from "crypto";
import { DOMParser } from "@xmldom/xmldom";

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
  if (ext === ".svg" || declaredMime === "image/svg+xml") {
    const svg = bytes.toString("utf-8").replace(/^\uFEFF/, "").trim();
    if (!svg) throw new Error("Declared SVG is empty.");
    let invalid = "";
    const doc = new DOMParser({ errorHandler: {
      warning: () => undefined,
      error: (message: string) => { invalid = message; },
      fatalError: (message: string) => { invalid = message; },
    } }).parseFromString(svg, "image/svg+xml");
    const closedRoot = /<\/svg\s*>\s*$/i.test(svg) || /<svg\b[^>]*\/\s*>\s*$/i.test(svg);
    if (invalid || !closedRoot || doc.documentElement?.localName?.toLowerCase() !== "svg") throw new Error(`Declared SVG is not parseable XML with an SVG root${invalid ? `: ${invalid}` : "."}`);
    return "image/svg+xml";
  }
  return declaredMime || "application/octet-stream";
}

const RASTER_EXT = /\.(png|jpe?g|gif|webp)$/i;
const RASTER_MIME = /^image\/(png|jpeg|gif|webp)$/i;

export function looksLikeRasterName(name: string, mime = ""): boolean {
  return RASTER_EXT.test(name) || RASTER_MIME.test(mime);
}

/**
 * PNG/JPEG/GIF/WebP must be binary. Models often pass UTF-8 text or a base64
 * string as `content`; decode that when it really is an image, otherwise fail
 * with a generate_image instruction instead of saving a fake .png.
 */
export function coerceArtifactBytes(name: string, declaredMime: string, input: { bytes?: Buffer; content?: string }): Buffer {
  if (input.bytes?.length) return input.bytes;
  const text = String(input.content ?? "");
  const utf = Buffer.from(text, "utf-8");
  if (!looksLikeRasterName(name, declaredMime)) return utf;
  try {
    validateBytes(name, declaredMime, utf);
    return utf;
  } catch {
    /* not raw PNG bytes */
  }
  let payload = text.trim();
  if (payload.startsWith("data:")) {
    const comma = payload.indexOf(",");
    if (comma >= 0) payload = payload.slice(comma + 1);
  }
  const compact = payload.replace(/\s+/g, "");
  if (compact.length >= 24 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    const decoded = Buffer.from(compact, "base64");
    if (decoded.length >= 8) {
      try {
        validateBytes(name, declaredMime, decoded);
        return decoded;
      } catch {
        /* decoded bytes still not an image */
      }
    }
  }
  throw new Error(
    `Declared ${name.toLowerCase().replace(/^.*(\.[a-z0-9]+)$/, "$1") || "image"} is not a real image. Call generate_image with a prompt so ORVYN produces PNG bytes. Do not pass text, markdown, or invented data to artifact_create.`
  );
}

export function isPreviewable(mime: string): boolean {
  return mime.startsWith("image/") || mime.startsWith("text/") || mime === "application/pdf" || mime === "application/json" || mime === "image/svg+xml";
}

/** 1×1 transparent PNG with a valid 8-byte signature. */
export const MINIMAL_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex"
);
