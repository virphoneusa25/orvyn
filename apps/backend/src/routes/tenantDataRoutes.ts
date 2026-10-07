import type { Request, Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import type { TenantPersistence } from "../persistence/TenantPersistence";
import { PROFILES, type PermissionProfile } from "../gateway/PermissionProfiles";

export interface TenantDataAccess {
  currentProjectRoot: string | null;
  localStore: Pick<TenantPersistence, "listMemories" | "saveMemory" | "getMemory" | "deleteMemory" | "listLearningRecords" | "setSetting">;
  toolGateway: { profile: PermissionProfile };
}

export function installTenantDataRoutes(router: Router, resolveTenant: (req: Request) => TenantDataAccess): void {
  router.get("/memory", asyncHandler(async (req, res) => {
    const t = resolveTenant(req);
    const root = String(req.query.projectRoot ?? t.currentProjectRoot ?? "").trim() || null;
    res.json({ memories: await t.localStore.listMemories(root) });
  }));

  router.post("/memory", asyncHandler(async (req, res) => {
    const t = resolveTenant(req);
    const content = String(req.body.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "content is required" });
    const scope = req.body.scope === "global" ? "global" : "project";
    const projectRoot = scope === "project" ? String(req.body.projectRoot ?? t.currentProjectRoot ?? "").trim() : null;
    if (scope === "project" && !projectRoot) return res.status(400).json({ error: "projectRoot is required for project memory" });
    const id = String(req.body.id ?? `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    await t.localStore.saveMemory({
      id, scope, projectRoot, kind: String(req.body.kind ?? "knowledge"),
      title: String(req.body.title ?? content.slice(0, 80)), content,
      source: req.body.source ? String(req.body.source) : "user", pinned: req.body.pinned === true,
    });
    res.status(201).json({ id });
  }));

  router.patch("/memory/:id", asyncHandler(async (req, res) => {
    const t = resolveTenant(req);
    const current = await t.localStore.getMemory(req.params.id);
    if (!current) return res.status(404).json({ error: "memory not found" });
    const scope = req.body.scope === "global" ? "global" : (req.body.scope === "project" ? "project" : current.scope);
    const projectRoot = scope === "project" ? String(req.body.projectRoot ?? current.projectRoot ?? t.currentProjectRoot ?? "").trim() : null;
    if (scope === "project" && !projectRoot) return res.status(400).json({ error: "projectRoot is required for project memory" });
    await t.localStore.saveMemory({
      id: current.id, scope, projectRoot,
      kind: String(req.body.kind ?? current.kind),
      title: String(req.body.title ?? current.title),
      content: String(req.body.content ?? current.content),
      source: String(req.body.source ?? current.source ?? "user"),
      pinned: typeof req.body.pinned === "boolean" ? req.body.pinned : current.pinned,
    });
    res.json({ memory: await t.localStore.getMemory(current.id) });
  }));

  router.delete("/memory/:id", asyncHandler(async (req, res) => {
    await resolveTenant(req).localStore.deleteMemory(req.params.id);
    res.status(204).end();
  }));

  router.get("/learning/skills", asyncHandler(async (req, res) => {
    const t = resolveTenant(req);
    res.json({ skills: (await t.localStore.listLearningRecords("skill", 80)).map((r) => r.payload) });
  }));

  router.get("/learning/datasets", asyncHandler(async (req, res) => {
    const t = resolveTenant(req);
    res.json({ datasets: (await t.localStore.listLearningRecords("dataset", 40)).map((r) => r.payload) });
  }));

  router.get("/profile", asyncHandler(async (req, res) => {
    const t = resolveTenant(req);
    res.json({
      profile: t.toolGateway.profile,
      profiles: Object.entries(PROFILES).map(([id, p]) => ({ id, ...p })),
    });
  }));

  router.post("/profile", asyncHandler(async (req, res) => {
    const t = resolveTenant(req);
    const profile = String(req.body.profile ?? "").toUpperCase() as PermissionProfile;
    if (!PROFILES[profile]) {
      return res.status(400).json({ error: `Unknown profile "${req.body.profile}". Valid: ${Object.keys(PROFILES).join(", ")}` });
    }
    await t.localStore.setSetting("profile", profile);
    t.toolGateway.profile = profile;
    res.json({ ok: true, profile });
  }));
}
