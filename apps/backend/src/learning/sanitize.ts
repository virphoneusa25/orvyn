const SECRET =
  /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|glm_[A-Za-z0-9_-]{12,}|mcp_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._\-]{12,}|(?:api[_-]?key|token|password|secret|credential)\s*[:=]\s*\S+)/gi;

export function sanitizeLearningText(value: unknown): string {
  return String(value ?? "").replace(SECRET, "[redacted]");
}

export function sanitizeRecord<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeLearningText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeRecord(v)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|credential|apikey|api_key/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = sanitizeRecord(v);
      }
    }
    return out as T;
  }
  return value;
}
