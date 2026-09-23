// Marketplace icons: registry artwork when published, otherwise the
// publisher's GitHub avatar or a well-known product mark. Never invent
// star ratings — icons are identity, not quality scores.

import { initials, serverLabel, type MarketServer } from "./mcpMarketplaceModel.ts";

export interface ResolvedIcon {
  kind: "image" | "initials";
  src?: string;
  letters: string;
  hue: string;
}

const BRANDS: { test: RegExp; src: string }[] = [
  { test: /\bgithub\b|\/github-mcp/i, src: brandSvg("#24292f", ghPath()) },
  { test: /\bpostgres|postgresql\b/i, src: brandSvg("#4169E1", pgPath()) },
  { test: /\bslack\b/i, src: brandSvg("#4A154B", slackPath()) },
  { test: /\bdocker\b/i, src: brandSvg("#2496ED", dockerPath()) },
  { test: /\bcloudflare\b/i, src: brandSvg("#F38020", cloudflarePath()) },
  { test: /\bstripe\b/i, src: brandSvg("#635BFF", stripePath()) },
  { test: /\bdiscord\b/i, src: brandSvg("#5865F2", discordPath()) },
  { test: /\bredis\b/i, src: brandSvg("#FF4438", redisPath()) },
  { test: /\bmongo/i, src: brandSvg("#00684A", mongoPath()) },
  { test: /\bkubernetes|\bk8s\b/i, src: brandSvg("#326CE5", k8sPath()) },
  { test: /\bnotion\b/i, src: brandSvg("#FFFFFF", notionPath()) },
  { test: /\blinear\b/i, src: brandSvg("#5E6AD2", linearPath()) },
  { test: /\bgitlab\b/i, src: brandSvg("#FC6D26", gitlabPath()) },
  { test: /\baws\b|amazon web/i, src: brandSvg("#FF9900", awsPath()) },
  { test: /\bgoogle\b/i, src: brandSvg("#4285F4", googlePath()) },
];

export function githubOwnerAvatar(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/github\.com\/+([^/?#]+)\/+([^/?#]+)/i);
  if (!m) return undefined;
  const owner = m[1];
  if (!owner || /^(topics|orgs|settings|marketplace|features|pricing|about|login)$/i.test(owner)) return undefined;
  return `https://github.com/${owner}.png?size=80`;
}

export function homepageFavicon(url?: string): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  try {
    const host = new URL(url).hostname;
    if (!host || host === "localhost") return undefined;
    return `https://icons.duckduckgo.com/ip3/${host}.ico`;
  } catch {
    return undefined;
  }
}

export function brandIconSrc(haystack: string): string | undefined {
  for (const brand of BRANDS) {
    if (brand.test.test(haystack)) return brand.src;
  }
  return undefined;
}

export function iconCandidates(server: MarketServer): string[] {
  const hay = `${serverLabel(server)} ${server.name} ${server.publisher ?? ""} ${server.canonicalId}`;
  const out: string[] = [];
  if (server.iconUrl) out.push(server.iconUrl);
  const avatar = githubOwnerAvatar(server.repository) ?? githubOwnerAvatar(server.homepage);
  if (avatar) out.push(avatar);
  const brand = brandIconSrc(hay);
  if (brand) out.push(brand);
  const fav = homepageFavicon(server.homepage) ?? homepageFavicon(server.repository);
  if (fav) out.push(fav);
  return [...new Set(out)];
}

export function resolveMarketplaceIcon(server: MarketServer): ResolvedIcon {
  const hue = server.sources.includes("official") ? "#4DA3FF" : server.sources.includes("private") ? "#22D3EE" : "#6C5CFF";
  const src = iconCandidates(server)[0];
  return { kind: src ? "image" : "initials", src, letters: initials(server), hue };
}

export function parseApiJson(status: number, text: string): { ok: boolean; body: any; error?: string } {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return { ok: status >= 200 && status < 300, body: {}, error: status >= 200 && status < 300 ? undefined : `HTTP ${status}` };
  }
  if (trimmed.startsWith("<")) {
    return {
      ok: false,
      body: {},
      error:
        status === 401 || status === 403
          ? "Marketplace needs a signed-in control plane session."
          : `Marketplace API returned HTML (HTTP ${status}). The connected backend is not serving /mcp/marketplace — use Local Mode or deploy the current control plane.`,
    };
  }
  try {
    const body = JSON.parse(trimmed);
    if (status >= 200 && status < 300) return { ok: true, body };
    return { ok: false, body, error: body?.error || `HTTP ${status}` };
  } catch {
    return { ok: false, body: {}, error: `Marketplace API returned non-JSON (HTTP ${status}).` };
  }
}

function brandSvg(bg: string, path: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${bg}"/><g transform="translate(4 4) scale(0.666)">${path}</g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function p(d: string, fill = "#fff"): string {
  return `<path fill="${fill}" d="${d}"/>`;
}

function ghPath(): string {
  return p("M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12");
}
function pgPath(): string {
  return p("M17.13 8.27s-.2-1.64-1.8-1.64c-1.5 0-2.05 1.45-2.17 2.3-.5 3.55.75 5.6.75 5.6s.4-2.55.15-4.35c-.2-1.4-.75-1.75-.75-1.75s.7 1.7 1.55 4.2c.7 2.05.55 4.55.55 4.55s1.85-1.15 2.55-4.85c.45-2.3-.83-4.06-.83-4.06zM10.4 16.7s.15-3.05-.7-6.15C8.95 8.4 8.1 7.7 8.1 7.7s.05 2.15.55 4.35c.55 2.4 1.75 4.65 1.75 4.65zM6.7 8.55S5.2 9.9 5.2 12.4c0 3.15 1.7 4.55 1.7 4.55S5.55 14.7 6 12.05c.3-1.75.7-3.5.7-3.5zM18.85 12.2c-.2-2.3-1.35-3.75-1.35-3.75s1.95 1.55 2.15 4.3c.2 2.55-1.05 4.9-1.05 4.9s.45-3.15.25-5.45z", "#fff");
}
function slackPath(): string {
  return p("M6 15.2A2.4 2.4 0 1 1 3.6 12.8V15.2H6zm1.2 0A2.4 2.4 0 1 1 9.6 17.6H7.2V15.2zm0-1.2V11.6A2.4 2.4 0 1 1 4.8 9.2H7.2v2.8zM8.4 9.2A2.4 2.4 0 1 1 10.8 6.8V9.2H8.4zm8.4-.4A2.4 2.4 0 1 1 19.2 11.2V8.8H16.8zm-1.2 0A2.4 2.4 0 1 1 13.2 6.4h2.4V8.8zm0 1.2v2.4A2.4 2.4 0 1 1 18 14.8h-2.4v-2.8zm-1.2 2.8A2.4 2.4 0 1 1 12 15.2v-2.4h2.4z");
}
function dockerPath(): string {
  return p("M13.4 8.3h2.3v2.2h-2.3zm-2.7 0h2.3v2.2H10.7zm-2.6 0h2.3v2.2H8.1zm0-2.6h2.3v2.2H8.1zm2.6 0h2.3v2.2H10.7zM5.4 8.3h2.3v2.2H5.4zm10.7 1.1c-.2 0-.4 0-.5.1-.1-1.1-1.2-1.6-1.2-1.6s-.2.8.1 1.6c-.2.1-.6.2-1 .2H3.4c-.1 1.8.3 4.2 2.1 5.8 1.6 1.4 3.8 1.7 5.8 1.6 2.4-.1 4.6-1.2 6-3.1 1-.1 2.5-.4 3.1-1.7.1-.2.2-.6 0-.7-.5-.3-1.7-.2-2.2-.1.8-1.2.9-2.3.4-3-.6.4-1.5.5-2.5.4z");
}
function cloudflarePath(): string {
  return p("M16.5 16.4h-9.8c-.3 0-.6-.2-.6-.5 0-.1 0-.2.1-.3l.9-1.5c.2-.4.7-.6 1.1-.6h5.3c.2 0 .3-.1.4-.2.1-.2 0-.4-.1-.5l-.6-1c-.2-.3 0-.7.4-.7h2.1c.3 0 .6.2.8.5l1.3 2.3c.2.4 0 .8-.4 1h-.9c-.2.5-.7.8-1.2.8zm-8.2-3.1h3.7c.5 0 .8.4.8.8 0 .1 0 .2-.1.3l-.2.4h2.2c.2 0 .4.1.4.3 0 .1 0 .2-.1.2l-.9 1.5c-.1.1-.2.2-.4.2H5.4c-.3 0-.5-.2-.5-.5 0-.1 0-.2.1-.3l1.4-2.4c.2-.3.5-.5.9-.5z");
}
function stripePath(): string {
  return p("M13.98 11.4c0-1.4-1.08-1.94-2.96-2.18-1.32-.17-2.5-.3-2.5-1.12 0-.64.62-1.06 1.74-1.06 2.2 0 2.02 1.5 3.06 1.5.66 0 1.12-.4 1.12-.96 0-1.42-2.16-2.48-4.14-2.48-2.12 0-4.02 1.1-4.02 3.22 0 1.56 1.18 2.1 3.04 2.34 1.4.18 2.42.3 2.42 1.16 0 .7-.76 1.14-1.9 1.14-2.36 0-2.02-1.72-3.2-1.72-.7 0-1.2.46-1.2 1.04 0 1.54 2.32 2.62 4.4 2.62 2.28.02 4.14-1.16 4.14-3.5z");
}
function discordPath(): string {
  return p("M20.3 4.37A19.8 19.8 0 0 0 15.88 3c-.2.36-.43.85-.59 1.23a18.3 18.3 0 0 0-5.58 0C9.55 3.85 9.3 3.36 9.1 3A19.7 19.7 0 0 0 4.68 4.38C.96 9.96.07 15.4.45 20.77A19.9 19.9 0 0 0 6.3 22.7c.45-.62.85-1.28 1.2-1.97-.66-.25-1.29-.56-1.89-.92.16-.12.31-.24.46-.37 3.58 1.7 7.47 1.7 11.02 0 .15.13.31.25.46.37-.6.36-1.23.67-1.89.92.35.69.75 1.35 1.2 1.97a19.8 19.8 0 0 0 5.86-1.92c.44-6.3-.73-11.7-4.07-16.4zM8.02 16.53c-1.08 0-1.97-1-1.97-2.22s.87-2.22 1.97-2.22 1.99 1 1.97 2.22-.87 2.22-1.97 2.22zm7.97 0c-1.08 0-1.97-1-1.97-2.22s.87-2.22 1.97-2.22 1.99 1 1.97 2.22-.87 2.22-1.97 2.22z");
}
function redisPath(): string {
  return p("M3 14.3 12 18l9-3.7v-2.2L12 15.8 3 12.1zm0-4.1L12 13.9l9-3.7V8L12 11.7 3 8zm9-6.2L3 7.7 12 11.4 21 7.7z");
}
function mongoPath(): string {
  return p("M12.3 22.5s.1-1.2-.4-2.1c-.5-1-1.5-1.6-1.5-1.6s1.2.2 2 1.4c.6 1 .6 2.3.6 2.3h-.7zM12 1.5s4.7 2.4 4.7 9.2c0 5.2-3.2 7.6-4 8.3-.2.2-.3.3-.3.3s-.2-.1-.4-.3c-.8-.7-4-3.1-4-8.3C8 3.9 12 1.5 12 1.5z");
}
function k8sPath(): string {
  return p("M12 1.4 21.2 6.8v10.4L12 22.6 2.8 17.2V6.8zm0 2.3L5.2 7.6v8.8L12 20.3l6.8-3.9V7.6zm0 2.5 4.6 2.7v5.2L12 16.8 7.4 14.1V8.9z");
}
function notionPath(): string {
  return p("M4.5 4.5h11.2l3.8 4.2v10.8H8.3L4.5 15.3zm2.2 2.2v8.4l2.2 2.1h8.4V9.5l-2.4-2.8z", "#111");
}
function linearPath(): string {
  return p("M3 14.5 14.5 3H21v6.5L9.5 21H3z");
}
function gitlabPath(): string {
  return p("M12 21 8.4 10.1h7.2zm8.6-10.9L23 14.3 12 21l3.6-10.9zM1 14.3l2.4-4.1L8.4 21zM7.1 3l1.3 4H3.4zm9.8 0 3.7 4h-5z");
}
function awsPath(): string {
  return p("M6.6 14.4c1.7 1.3 4.1 2 6.4 2 1.6 0 3.3-.3 4.7-1 .4-.2.8.2.4.5-1.6 1.4-4.1 2.1-6.5 2.1-2.5 0-5.2-.8-7.2-2.3-.3-.2 0-.7.4-.5zm17-1.1c-.2-.3-1.2-.1-1.7 0-.1 0-.2-.1-.1-.2.6-.4 1.6-1 1.8-1.3.1-.1 0-.3-.1-.2-.8.5-1.7.9-2.6 1.1-.1 0-.2.2-.1.3.2.3.5.7.5 1.1 0 .1.1.2.2.1.5-.1 1.4-.4 2-.8.1 0 .2-.1.1-.1zM13.6 6.2c0-.7.1-1.2.5-1.6.3-.3.7-.4 1.1-.4.9 0 1.5.6 1.5 1.8v4.3h1.5V5.9c0-1.6-1-2.6-2.5-2.6-1.1 0-1.9.5-2.3 1.4h-.1l-.2-1.2h-1.3c0 .4.1 1.1.1 1.8v4.8h1.6zm-4.5 4.6c.9 0 1.6-.4 2-1h.1l.2.8h1.3V5.5c0-.6.1-1.3.1-1.8H11l-.1 1h-.1c-.4-.8-1.2-1.3-2.2-1.3-1.7 0-2.9 1.4-2.9 3.2 0 1.9 1.1 3.2 2.9 3.2zm.3-5.2c1 0 1.6.8 1.6 2s-.6 2-1.6 2-1.6-.8-1.6-2 .7-2 1.6-2z", "#232F3E");
}
function googlePath(): string {
  return `${p("M12 10.8v2.6h5.4c-.2 1.3-1.6 3.8-5.4 3.8-3.2 0-5.9-2.7-5.9-6s2.6-6 5.9-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 2.5 14.6 1.5 12 1.5 6.8 1.5 2.5 5.8 2.5 11.1S6.8 20.7 12 20.7c6.1 0 8.4-4.3 8.4-6.5 0-.4 0-.8-.1-1.1z")}`;
}
