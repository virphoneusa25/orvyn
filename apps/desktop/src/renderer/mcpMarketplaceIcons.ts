// Marketplace icons use the same source as StarHunt: the publisher's
// GitHub avatar (or a published registry icon). Product rows such as
// "GitHub MCP" use github.com/github.png — not a hand-drawn invertocat.

import { initials, serverLabel, type MarketServer } from "./mcpMarketplaceModel.ts";

export interface ResolvedIcon {
  kind: "image" | "initials";
  src?: string;
  letters: string;
  hue: string;
}

const AVATAR = (owner: string) => `https://github.com/${owner}.png?size=160`;

/** Tight identity only — "github" / "GitHub MCP", not "obsidian-github-mcp". */
const PRODUCT_ORGS: { match: RegExp; owner: string }[] = [
  { match: /^(github|githubmcp)$/i, owner: "github" },
  { match: /^(postgres|postgresql|postgresqlmcp)$/i, owner: "postgres" },
  { match: /^(slack|slackmcp)$/i, owner: "slackapi" },
  { match: /^(docker|dockermcp)$/i, owner: "docker" },
  { match: /^(cloudflare|cloudflaremcp)$/i, owner: "cloudflare" },
  { match: /^(stripe|stripemcp)$/i, owner: "stripe" },
  { match: /^(discord|discordmcp)$/i, owner: "discord" },
  { match: /^(redis|redismcp)$/i, owner: "redis" },
  { match: /^(mongo|mongodb|mongodbmcp)$/i, owner: "mongodb" },
  { match: /^(kubernetes|k8s)$/i, owner: "kubernetes" },
  { match: /^(notion|notionmcp)$/i, owner: "makenotion" },
  { match: /^(linear|linearmcp)$/i, owner: "linear" },
  { match: /^(gitlab|gitlabmcp)$/i, owner: "gitlab" },
  { match: /^(aws|amazon)$/i, owner: "aws" },
  { match: /^(google|googlemcp)$/i, owner: "google" },
];

export function productIdentity(label: string, name = ""): string {
  if (/io\.github\.github\/github-mcp/i.test(name)) return "github";
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(mcp|server|official)\b/gi, " ")
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  return clean(label) || clean(name.split("/").pop() ?? "");
}

export function brandIconSrc(label: string, name = ""): string | undefined {
  const identity = productIdentity(label, name);
  for (const row of PRODUCT_ORGS) {
    if (row.match.test(identity)) return AVATAR(row.owner);
  }
  return undefined;
}

export function githubOwnerAvatar(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/github\.com\/+([^/?#]+)\/+([^/?#]+)/i);
  if (!m) return undefined;
  const owner = m[1];
  if (!owner || /^(topics|orgs|settings|marketplace|features|pricing|about|login)$/i.test(owner)) return undefined;
  return AVATAR(owner);
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

export function iconCandidates(server: MarketServer): string[] {
  const label = serverLabel(server);
  const product = brandIconSrc(label, server.name);
  const out: string[] = [];
  if (product) out.push(product);
  if (server.iconUrl) out.push(server.iconUrl);
  const avatar = githubOwnerAvatar(server.repository) ?? githubOwnerAvatar(server.homepage);
  if (avatar) out.push(avatar);
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
