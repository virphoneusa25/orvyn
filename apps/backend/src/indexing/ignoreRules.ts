import { promises as fs } from "fs";
import * as path from "path";

export const INDEX_SCHEMA_VERSION = "orvyn-intel-2";

export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".orvyn",
  ".next",
  ".cache",
  "vendor",
  "tmp",
  "temp",
  "logs",
  "release",
  ".turbo",
  ".vercel",
  ".output",
  "__pycache__",
  ".venv",
  "venv",
  "target",
]);

export const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".7z", ".rar",
  ".mp4", ".mov", ".mp3", ".wav",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pdf", ".map", ".lock",
]);

export const SECRET_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials.json",
  "service-account.json",
]);

const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];
const SECRET_PREFIXES = [".env.", "id_rsa", "id_ed25519"];

export const MAX_FILE_BYTES = 500_000;
export const MAX_INDEX_FILES = Number(process.env.ORVYN_MAX_INDEX_FILES) || 1200;

export function isSecretPath(relativePath: string): boolean {
  const base = relativePath.split(/[\\/]/).pop() ?? "";
  const lower = base.toLowerCase();
  if (SECRET_NAMES.has(base) || SECRET_NAMES.has(lower)) return true;
  if (base.startsWith(".env")) return true;
  if (lower.includes("secret") || lower.includes("credential")) return true;
  if (SECRET_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  if (SECRET_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return false;
}

export function shouldIgnoreRelative(relativePath: string, extraGlobs: string[] = []): boolean {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] ?? "";
  if (isSecretPath(relativePath)) return true;
  const ext = path.extname(base).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  const posix = relativePath.replace(/\\/g, "/");
  for (const glob of extraGlobs) {
    if (matchIgnoreGlob(posix, glob)) return true;
  }
  return false;
}

/** Minimal gitignore-style matcher: directory names, trailing slash, * wildcards, leading /. */
export function matchIgnoreGlob(relativePath: string, pattern: string): boolean {
  const pat = pattern.trim();
  if (!pat || pat.startsWith("#") || pat.startsWith("!")) return false;
  const clean = pat.replace(/^\//, "").replace(/\/$/, "");
  const posix = relativePath.replace(/\\/g, "/");
  if (pat.endsWith("/")) {
    return posix.split("/").includes(clean) || posix.startsWith(clean + "/");
  }
  if (!clean.includes("*")) {
    return posix === clean || posix.endsWith("/" + clean) || posix.split("/").includes(clean);
  }
  const escaped = clean.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`(^|/)${escaped}$`).test(posix);
}

export async function loadIgnoreGlobs(projectRoot: string): Promise<string[]> {
  const globs: string[] = [];
  for (const name of [".gitignore", ".orvynignore"]) {
    try {
      const text = await fs.readFile(path.join(projectRoot, name), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith("#")) globs.push(t);
      }
    } catch {
      /* optional */
    }
  }
  return globs;
}

export function skipReason(relativePath: string, size: number, extraGlobs: string[] = []): string | null {
  if (isSecretPath(relativePath)) return "secret";
  if (shouldIgnoreRelative(relativePath, extraGlobs)) return "ignored";
  if (size > MAX_FILE_BYTES) return "too-large";
  const base = relativePath.split(/[\\/]/).pop() ?? "";
  if (base.endsWith(".min.js") || base.endsWith(".min.css") || base.endsWith(".bundle.js")) return "minified";
  return null;
}
