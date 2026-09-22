// Normalized local-dev preview URLs from terminal / tool output.
// Emitted as preview.available so the Workbench does not rely only on renderer regex.

const LOCAL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d{2,5}))?(?:\/[^\s"'<>]*)?/gi;
const DEV_HINT = /\b(vite|next\.js|nextjs|webpack|astro|nuxt|remix|angular|vue|react|ready in \d|local:\s*http)/i;

export function detectDevServerUrls(text: string): { url: string; port?: number; label: string }[] {
  if (!text) return [];
  const found: { url: string; port?: number; label: string }[] = [];
  const seen = new Set<string>();
  const re = new RegExp(LOCAL.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0]!.replace(/[.,);]+$/, "");
    if (seen.has(raw)) continue;
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    } catch {
      continue;
    }
    seen.add(raw);
    const port = m[1] ? Number(m[1]) : undefined;
    found.push({
      url: raw,
      port,
      label: port ? `Preview :${port}` : "Preview",
    });
  }
  return DEV_HINT.test(text) || found.length > 0 ? found : [];
}
