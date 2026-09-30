// apps/worker/src/sandbox/policies.ts
//
// Network policy templates live in source control (apps/worker/sandbox-policies/
// <id>.v<N>.json) and are the ONLY policies a sandbox can start with. Deny by
// default: a template lists every host a sandbox may reach and the binaries
// that may reach it. The model never writes policy; an approved expansion
// request can only switch to another reviewed template (with validated
// parameters such as an SSH host).

import * as fs from "fs";
import * as path from "path";
import { ALL_TEMPLATES, SandboxError, isPolicyTemplate, type PolicyTemplateId } from "./types";

export interface PolicyTemplate {
  id: PolicyTemplateId;
  version: number;
  description: string;
  parameters: string[];
  /** OpenShell SandboxPolicy in proto-JSON form (snake_case field names). */
  policy: Record<string, any>;
}

const DEFAULT_DIR = path.resolve(__dirname, "..", "..", "sandbox-policies");

let cache: Map<PolicyTemplateId, PolicyTemplate> | null = null;
let cacheDir = "";

/** Loads the newest version of every template. Throws if one is missing or malformed. */
export function loadTemplates(dir = process.env.ORVYN_SANDBOX_POLICY_DIR || DEFAULT_DIR): Map<PolicyTemplateId, PolicyTemplate> {
  if (cache && cacheDir === dir) return cache;
  const found = new Map<PolicyTemplateId, PolicyTemplate>();
  for (const file of fs.readdirSync(dir)) {
    const m = /^([a-z-]+)\.v(\d+)\.json$/.exec(file);
    if (!m) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as PolicyTemplate;
    if (!isPolicyTemplate(doc.id) || doc.id !== m[1] || doc.version !== Number(m[2])) {
      throw new Error(`sandbox policy ${file}: id/version do not match the file name`);
    }
    validateTemplate(doc);
    const prev = found.get(doc.id);
    if (!prev || prev.version < doc.version) found.set(doc.id, doc);
  }
  for (const id of ALL_TEMPLATES) if (!found.has(id)) throw new Error(`sandbox policy template missing: ${id}`);
  cache = found;
  cacheDir = dir;
  return found;
}

export function getTemplate(id: PolicyTemplateId): PolicyTemplate {
  const t = loadTemplates().get(id);
  if (!t) throw new SandboxError("tool_bad_args", `Unknown sandbox policy template: ${id}`, false);
  return t;
}

/** Structural checks that keep a template deny-by-default and non-escalating. */
export function validateTemplate(t: PolicyTemplate): void {
  const p = t.policy;
  if (!p || p.version !== 1) throw new Error(`${t.id}: policy.version must be 1`);
  const rw: string[] = p.filesystem?.read_write ?? [];
  // A sandbox never gets write access outside its workspace and scratch space.
  for (const dir of rw) {
    if (!["/workspace", "/tmp", "/dev/null"].includes(dir)) throw new Error(`${t.id}: read_write path not allowed: ${dir}`);
  }
  if (!p.process?.run_as_user || p.process.run_as_user === "root") throw new Error(`${t.id}: must run as a non-root user`);
  for (const [name, rule] of Object.entries<any>(p.network_policies ?? {})) {
    if (!Array.isArray(rule.binaries) || !rule.binaries.length) throw new Error(`${t.id}/${name}: every rule names its binaries`);
    for (const ep of rule.endpoints ?? []) {
      if (!ep.host) throw new Error(`${t.id}/${name}: hostless endpoints are not allowed`);
      if (/^\*+$/.test(ep.host) || /^\*\*?\.[^.]+$/.test(ep.host)) throw new Error(`${t.id}/${name}: host wildcard too broad: ${ep.host}`);
      if (Array.isArray(ep.allowed_ips) && ep.allowed_ips.length) throw new Error(`${t.id}/${name}: allowed_ips would bypass the internal-address guard`);
      if (ep.protocol && ep.protocol !== "tcp" && ep.enforcement !== "NETWORK_ENFORCEMENT_MODE_ENFORCE") {
        throw new Error(`${t.id}/${name}: inspected endpoints must enforce, not audit`);
      }
    }
  }
}

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Public hostnames or public IPv4 only. Internal, loopback and metadata addresses are refused. */
export function validatePublicHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return false;
  const ip = IPV4_RE.exec(h);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if ([a, b, Number(ip[3]), Number(ip[4])].some((n) => n > 255)) return false;
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
    return true;
  }
  return HOST_RE.test(h);
}

/**
 * Renders a template to a concrete policy. Parameters are substituted into
 * endpoint hosts only, and each value must be a public host. A template
 * with an unfilled parameter drops that endpoint (deny), never widens it.
 */
export function renderPolicy(id: PolicyTemplateId, params: Record<string, string[]> = {}): { version: number; policy: Record<string, any> } {
  const t = getTemplate(id);
  const policy = JSON.parse(JSON.stringify(t.policy));
  for (const rule of Object.values<any>(policy.network_policies ?? {})) {
    const out: any[] = [];
    for (const ep of rule.endpoints ?? []) {
      const m = /^\{\{(\w+)\}\}$/.exec(String(ep.host));
      if (!m) { out.push(ep); continue; }
      for (const value of params[m[1]!] ?? []) {
        if (!validatePublicHost(value)) throw new SandboxError("network_policy_denied", `Host not allowed in a sandbox policy: ${value}`, false);
        out.push({ ...ep, host: value.trim().toLowerCase() });
      }
    }
    rule.endpoints = out;
  }
  for (const [name, rule] of Object.entries<any>(policy.network_policies ?? {})) {
    if (!rule.endpoints.length) delete policy.network_policies[name];
  }
  return { version: t.version, policy };
}

/** Hosts a rendered policy allows — for audit and admin display. */
export function allowedHosts(policy: Record<string, any>): string[] {
  const hosts = new Set<string>();
  for (const rule of Object.values<any>(policy.network_policies ?? {})) {
    for (const ep of rule.endpoints ?? []) hosts.add(`${ep.host}:${ep.port ?? (ep.ports ?? []).join(",")}`);
  }
  return [...hosts].sort();
}
