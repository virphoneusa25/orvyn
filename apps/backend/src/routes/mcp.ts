// apps/backend/src/routes/mcp.ts
//
// MCP host REST surface: server CRUD, connection lifecycle, truthful
// statuses, tool search, permission policy. All responses are sanitized —
// secret values never leave the backend.

import { Router } from "express";

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
      t.mcpManager.setEnabled(req.params.id, true);
      res.json({ server: await t.mcpManager.connect(req.params.id) });
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

  return r;
}
