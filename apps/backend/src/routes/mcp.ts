// apps/backend/src/routes/mcp.ts
//
// MCP host REST surface: server CRUD, connection lifecycle, truthful
// statuses, tool search, permission policy. All responses are sanitized —
// secret values never leave the backend.

import { Router } from "express";
import { marketplaceFor } from "../mcp/marketplace/service";
import { MARKETPLACE_CATEGORIES } from "../mcp/marketplace/types";
import { hardeningFor } from "../mcp/hardening/hardening";

export function mcpRouter(requireTenant: (req: any) => any): Router {
  const r = Router();

  r.get("/servers", (req, res) => {
    const t = requireTenant(req);
    res.json({ servers: t.mcpManager.listServers().map((c: any) => ({ ...c, headers: c.headers ? Object.fromEntries(Object.keys(c.headers).map((k) => [k, "***"])) : undefined })) });
  });

  r.post("/servers", (req, res) => {
    const t = requireTenant(req);
    try {
      const cfg = t.mcpManager.addServer({
        name: String(req.body.name ?? "server"),
        transport: req.body.transport === "http" ? "http" : "stdio",
        command: req.body.command,
        args: req.body.args,
        env: req.body.env,
        cwd: req.body.cwd,
        url: req.body.url,
        headers: req.body.headers,
        description: req.body.description,
        secretValues: req.body.secrets,
      });
      res.status(201).json({ server: { ...cfg, headers: cfg.headers ? Object.fromEntries(Object.keys(cfg.headers).map((k) => [k, "***"])) : undefined } });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  r.patch("/servers/:id", (req, res) => {
    const t = requireTenant(req);
    const updated = t.mcpManager.updateServer(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Unknown MCP server" });
    res.json({ server: updated });
  });

  r.delete("/servers/:id", (req, res) => {
    const t = requireTenant(req);
    res.json({ ok: t.mcpManager.removeServer(req.params.id) });
  });

  r.get("/statuses", (req, res) => {
    const t = requireTenant(req);
    res.json({ servers: t.mcpManager.statuses() });
  });

  r.post("/servers/:id/connect", async (req, res) => {
    const t = requireTenant(req);
    try {
      const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
      const auth = await harden.ensureFreshToken(req.params.id);
      if (auth === "needs-auth") {
        t.mcpManager.markNeedsAuth(req.params.id, "Needs Auth");
        return res.json({ server: t.mcpManager.status(req.params.id) });
      }
      t.mcpManager.setEnabled(req.params.id, true);
      const server = await t.mcpManager.connect(req.params.id);
      harden.appendAudit("enable", { serverId: req.params.id });
      res.json({ server });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post("/servers/:id/disconnect", async (req, res) => {
    const t = requireTenant(req);
    await t.mcpManager.disconnect(req.params.id).catch(() => {});
    t.mcpManager.setEnabled(req.params.id, false);
    res.json({ server: t.mcpManager.status(req.params.id) });
  });

  r.post("/servers/:id/reconnect", async (req, res) => {
    const t = requireTenant(req);
    res.json({ server: await t.mcpManager.reconnect(req.params.id) });
  });

  /** Test connection without saving state (Add Server dialog). */
  r.post("/test", async (req, res) => {
    const t = requireTenant(req);
    try {
      const cfg = t.mcpManager.addServer({
        name: String(req.body.name ?? "test"),
        transport: req.body.transport === "http" ? "http" : "stdio",
        command: req.body.command,
        args: req.body.args,
        env: req.body.env,
        url: req.body.url,
        headers: req.body.headers,
        secretValues: req.body.secrets,
      });
      const status = await t.mcpManager.connect(cfg.id);
      const ok = status.state === "CONNECTED";
      // Test servers are removed unless the caller asks to keep (save flow
      // re-adds via POST /servers + connect).
      t.mcpManager.removeServer(cfg.id);
      res.json({ ok, status });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  r.get("/search", (req, res) => {
    const t = requireTenant(req);
    res.json({ tools: t.mcpManager.searchTools(String(req.query.q ?? "")) });
  });

  r.post("/servers/:id/permissions/tool", (req, res) => {
    const t = requireTenant(req);
    t.mcpManager.setToolPermission(req.params.id, String(req.body.tool ?? ""), ["ALLOW", "ASK", "DENY"].includes(req.body.mode) ? req.body.mode : "ASK");
    res.json({ ok: true });
  });

  r.post("/servers/:id/permissions/server", (req, res) => {
    const t = requireTenant(req);
    t.mcpManager.setServerDefaults(req.params.id, req.body.defaults ?? {});
    res.json({ ok: true });
  });

  /** Compact capability summary for agent context. */
  r.get("/capabilities", (req, res) => {
    const t = requireTenant(req);
    res.json({ summary: t.mcpManager.capabilitySummary() });
  });

  r.get("/marketplace/search", async (req, res) => {
    const t = requireTenant(req);
    const market = marketplaceFor(t.mcpManager, t.localStore);
    const q = String(req.query.q ?? "");
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    if (refresh) market.invalidateCatalog();
    try {
      const out = q.trim()
        ? await market.search({
            query: q,
            limit: Number(req.query.limit ?? 24) || 24,
            cursor: req.query.cursor ? String(req.query.cursor) : undefined,
            category: req.query.category ? String(req.query.category) : undefined,
            refresh,
          })
        : await market.featured({ refresh });
      res.json(out);
    } catch (err: any) {
      res.status(200).json({
        results: [],
        health: [],
        providers: {},
        degraded: [String(err?.message ?? "Marketplace is temporarily offline.").slice(0, 160)],
        degradedFlag: true,
        fromCache: false,
        error: "Marketplace is temporarily offline.",
      });
    }
  });

  r.post("/marketplace/refresh", async (req, res) => {
    const t = requireTenant(req);
    const market = marketplaceFor(t.mcpManager, t.localStore);
    market.invalidateCatalog(req.body?.query ? String(req.body.query) : undefined);
    res.json({ ok: true });
  });

  r.get("/marketplace/capabilities", (req, res) => {
    const t = requireTenant(req);
    res.json(marketplaceFor(t.mcpManager, t.localStore).capabilities());
  });

  r.get("/marketplace/health", async (req, res) => {
    const t = requireTenant(req);
    const market = marketplaceFor(t.mcpManager, t.localStore);
    res.json({ providers: await market.health(), ...market.capabilities() });
  });

  r.get("/marketplace/categories", (_req, res) => {
    res.json({ categories: MARKETPLACE_CATEGORIES });
  });

  r.post("/marketplace/install", async (req, res) => {
    const t = requireTenant(req);
    try {
      const out = await marketplaceFor(t.mcpManager, t.localStore).install(req.body.server, {
        secrets: req.body.secrets,
        connect: req.body.connect !== false,
        cwd: req.body.cwd,
      });
      const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
      harden.appendAudit("install", { serverId: out.config.id, marketplaceId: req.body.server?.canonicalId, version: out.plan.version });
      if (harden.policy().requireApprovalForInstall) {
        t.mcpManager.setEnabled(out.config.id, false);
      }
      res.status(201).json({
        server: out.config.id,
        status: out.status,
        plan: { transport: out.plan.transport, version: out.plan.version, networkRequired: out.plan.networkRequired },
        needsOAuth: out.needsOAuth,
        provenance: out.config.provenance,
        scriptWarning: (out.config as { provenanceWarning?: string }).provenanceWarning ?? out.config.provenance?.scripts?.length
          ? `This package runs ${(out.config.provenance?.scripts ?? []).join(", ")} during install.`
          : undefined,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  r.get("/marketplace/secrets", (req, res) => {
    const t = requireTenant(req);
    res.json({ configured: marketplaceFor(t.mcpManager, t.localStore).providerSecretStatus() });
  });

  r.put("/marketplace/secrets", (req, res) => {
    const t = requireTenant(req);
    const market = marketplaceFor(t.mcpManager, t.localStore);
    if (req.body?.glama !== undefined) market.setProviderSecret("glama", String(req.body.glama ?? ""));
    if (req.body?.smithery !== undefined) market.setProviderSecret("smithery", String(req.body.smithery ?? ""));
    res.json({ configured: market.providerSecretStatus() });
  });

  r.get("/marketplace/registries", (req, res) => {
    const t = requireTenant(req);
    res.json({ registries: marketplaceFor(t.mcpManager, t.localStore).listPrivateRegistries() });
  });

  r.post("/marketplace/registries", (req, res) => {
    const t = requireTenant(req);
    const id = String(req.body.id ?? `reg_${Date.now()}`);
    const cfg = marketplaceFor(t.mcpManager, t.localStore).upsertPrivateRegistry(
      {
        id,
        name: String(req.body.name ?? "Private registry"),
        url: String(req.body.url ?? ""),
        enabled: req.body.enabled !== false,
        authType: req.body.token ? "bearer" : "none",
      },
      req.body.token
    );
    res.status(201).json({ registry: cfg });
  });

  r.get("/marketplace/featured", async (req, res) => {
    const t = requireTenant(req);
    try {
      res.json(await marketplaceFor(t.mcpManager, t.localStore).featured());
    } catch (err: any) {
      res.status(200).json({
        results: [],
        health: [],
        providers: {},
        degraded: [String(err?.message ?? "Marketplace is temporarily offline.").slice(0, 160)],
        degradedFlag: true,
        fromCache: false,
        error: "Marketplace is temporarily offline.",
      });
    }
  });

  r.get("/marketplace/updates", (req, res) => {
    const t = requireTenant(req);
    res.json({ updates: marketplaceFor(t.mcpManager, t.localStore).updates() });
  });

  r.get("/marketplace/export", (req, res) => {
    const t = requireTenant(req);
    res.json(marketplaceFor(t.mcpManager, t.localStore).exportConfig());
  });

  r.post("/marketplace/import", (req, res) => {
    const t = requireTenant(req);
    const market = marketplaceFor(t.mcpManager, t.localStore);
    const drafts = market.previewImport(req.body.config ?? req.body);
    if (!req.body.confirm) return res.json({ drafts, imported: 0, needsConfirm: true });
    res.json(market.importDrafts(drafts, true));
  });

  r.post("/oauth/start", async (req, res) => {
    const t = requireTenant(req);
    try {
      const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
      const out = await harden.startOAuth({
        serverId: String(req.body.serverId ?? ""),
        resource: String(req.body.resource ?? t.mcpManager.listServers().find((s: { id: string }) => s.id === req.body.serverId)?.url ?? ""),
        clientId: req.body.clientId,
      });
      harden.appendAudit("connect", { serverId: req.body.serverId, method: "oauth-start" });
      res.json(out);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  r.get("/oauth/status", (req, res) => {
    const t = requireTenant(req);
    const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
    res.json(harden.oauthStatus(String(req.query.state ?? "")));
  });

  r.post("/oauth/disconnect/:id", async (req, res) => {
    const t = requireTenant(req);
    const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
    await harden.disconnectAccount(req.params.id);
    res.json({ server: t.mcpManager.status(req.params.id) });
  });

  r.post("/oauth/refresh/:id", async (req, res) => {
    const t = requireTenant(req);
    const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
    const status = await harden.ensureFreshToken(req.params.id);
    res.json({ status, server: t.mcpManager.status(req.params.id) });
  });

  r.post("/gateway/invoke", async (req, res) => {
    const t = requireTenant(req);
    const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
    const out = await harden.gateway.invoke({
      tenantId: String(req.body.tenantId ?? t.id),
      expectedTenantId: t.id,
      serverId: String(req.body.serverId ?? ""),
      tool: String(req.body.tool ?? ""),
      args: req.body.args ?? {},
      runId: req.body.runId,
      projectRoot: req.body.projectRoot ?? t.currentProjectRoot,
      cloudRun: req.body.cloudRun === true,
    });
    harden.appendAudit("tool invocation", { serverId: req.body.serverId, tool: req.body.tool, ok: out.ok, cloudRun: req.body.cloudRun === true });
    res.status(out.ok ? 200 : 403).json(out);
  });

  r.get("/gateway/health", (req, res) => {
    const t = requireTenant(req);
    const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
    const servers = t.mcpManager.statuses().map((s: any) => {
      const snap = harden.obs.snapshot(s.id, {
        state: s.state,
        toolCount: s.toolCount,
        lastConnectedAt: s.lastConnectedAt,
        enabled: s.enabled,
        blocked: s.blocked,
      });
      return { ...s, health: snap.status, latencyMs: snap.latencyMs, circuitReason: snap.circuitReason, restartCount: snap.restartCount };
    });
    res.json({
      gateway: harden.gateway.available ? "online" : "unavailable",
      connected: servers.filter((s: any) => s.state === "CONNECTED").length,
      failing: servers.filter((s: any) => s.health === "Error" || s.health === "Offline" || s.circuitReason),
      servers,
    });
  });

  r.get("/policy", (req, res) => {
    const t = requireTenant(req);
    res.json({ policy: hardeningFor(t.mcpManager, t.localStore, t.id).policy() });
  });

  r.put("/policy", (req, res) => {
    const t = requireTenant(req);
    const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
    const policy = harden.setPolicy(req.body ?? {});
    harden.appendAudit("approval", { action: "policy.update", mode: policy.mode });
    res.json({ policy });
  });

  r.get("/health", (req, res) => {
    const t = requireTenant(req);
    const harden = hardeningFor(t.mcpManager, t.localStore, t.id);
    const servers = t.mcpManager.statuses().map((s: any) =>
      harden.obs.snapshot(s.id, {
        state: s.state,
        toolCount: s.toolCount,
        lastConnectedAt: s.lastConnectedAt,
        enabled: s.enabled,
        blocked: s.blocked,
      })
    );
    res.json({
      servers,
      diagnostics: marketplaceFor(t.mcpManager, t.localStore).index.diagnostics(),
    });
  });

  r.patch("/servers/:id/scope", (req, res) => {
    const t = requireTenant(req);
    const scope = ["global", "project", "run"].includes(req.body.scope) ? req.body.scope : "global";
    const cwd = scope === "project" ? (req.body.cwd ?? t.currentProjectRoot) : undefined;
    const updated = t.mcpManager.setScope(req.params.id, scope, cwd ?? undefined);
    if (!updated) return res.status(404).json({ error: "Unknown MCP server" });
    hardeningFor(t.mcpManager, t.localStore, t.id).appendAudit("update", { serverId: req.params.id, scope });
    res.json({ server: updated });
  });

  r.post("/servers/:id/block", async (req, res) => {
    const t = requireTenant(req);
    const blocked = req.body.blocked !== false;
    const updated = t.mcpManager.setBlocked(req.params.id, blocked, req.body.reason);
    if (!updated) return res.status(404).json({ error: "Unknown MCP server" });
    hardeningFor(t.mcpManager, t.localStore, t.id).appendAudit(blocked ? "denial" : "approval", { serverId: req.params.id, reason: req.body.reason });
    res.json({ server: updated });
  });

  r.post("/servers/:id/sandbox", async (req, res) => {
    const t = requireTenant(req);
    try {
      const status = await t.mcpManager.sandboxProbe(req.params.id);
      res.json({ server: status });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  r.get("/provenance", (req, res) => {
    const t = requireTenant(req);
    res.json({ provenance: hardeningFor(t.mcpManager, t.localStore, t.id).readProvenance() });
  });

  r.post("/inspect", async (req, res) => {
    const t = requireTenant(req);
    try {
      const rec = await hardeningFor(t.mcpManager, t.localStore, t.id).inspectInstall(String(req.body.package ?? ""), String(req.body.version ?? ""));
      res.json({ provenance: rec });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  r.get("/audit", (req, res) => {
    const t = requireTenant(req);
    res.json({ events: hardeningFor(t.mcpManager, t.localStore, t.id).readAudit() });
  });

  r.get("/capabilities/diagnostics", (req, res) => {
    const t = requireTenant(req);
    res.json(marketplaceFor(t.mcpManager, t.localStore).index.diagnostics());
  });

  return r;
}
