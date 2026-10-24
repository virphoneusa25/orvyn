import type { Request, Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import type { ModelService } from "../services/ModelService";
import type { TenantPersistence } from "../persistence/TenantPersistence";
import { customerCatalogEnabled } from "../models/customerCatalog";
import { buildUserModel, publicUserModel, sealModelConfig } from "../models/userModels";
import { requiredCapability } from "@orvyn/ai-core";

export interface ModelSettingsTenant {
  id: string;
  modelService: ModelService;
  localStore: Pick<TenantPersistence, "saveModel" | "deleteModel" | "setSetting">;
}
const queues = new WeakMap<ModelService, Promise<void>>();
function serializeModelSettings<T>(service: ModelService, operation: () => Promise<T>): Promise<T> {
  const pending = (queues.get(service) ?? Promise.resolve()).then(operation);
  queues.set(service, pending.then(() => {}, () => {}));
  return pending;
}
export function installModelSettingsRoutes(router: Router, resolveTenant: (req: Request) => ModelSettingsTenant): void {
  router.post("/models", asyncHandler(async (req, res) => {
    const resolved = resolveTenant(req);
    await serializeModelSettings(resolved.modelService, async () => {
      const t = resolved;
      try {
        if (!customerCatalogEnabled()) {
          const provider = t.modelService.prepareModel(req.body, "user");
          await t.localStore.saveModel(provider.config);
          t.modelService.publishModel(provider, "user");
          return res.status(201).json({ model: provider.config });
        }
        let config = await buildUserModel(req.body ?? {});
        // Two models with the same name get distinct ids.
        for (let n = 2; t.modelService.registry.get(config.id); n++) config = { ...config, id: `${config.id.replace(/-\d+$/, "")}-${n}` };
        const provider = t.modelService.prepareModel(config, "user");
        await t.localStore.saveModel(sealModelConfig(provider.config, t.id));
        t.modelService.publishModel(provider, "user");
        res.status(201).json({ model: publicUserModel(provider.config) });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }

    });
  }));

  router.put("/models/preferred", asyncHandler(async (req, res) => {
    const resolved = resolveTenant(req);
    await serializeModelSettings(resolved.modelService, async () => {
      const t = resolved;
      const id = req.body?.modelId ? String(req.body.modelId) : null;
      if (id && !t.modelService.isUserModel(id)) return res.status(400).json({ error: "Choose one of your own models, or clear the default." });
      await t.localStore.setSetting("preferredModel", id ?? "");
      t.modelService.preferredModel = id;
      res.json({ preferredModelId: id });

    });
  }));

  router.put("/models/:id", asyncHandler(async (req, res) => {
    const resolved = resolveTenant(req);
    await serializeModelSettings(resolved.modelService, async () => {
      const t = resolved;
      const ms = t.modelService;
      try {
        if (!customerCatalogEnabled()) {
          const config = { ...req.body, id: req.params.id };
          const provider = ms.prepareModel(config, "user");
          await t.localStore.saveModel(provider.config);
          ms.publishModel(provider, "user");
          return res.json({ model: provider.config });
        }
        if (!ms.isUserModel(req.params.id)) return res.status(403).json({ error: "ORVYN's models can't be changed. Add your own model instead.", code: "PLATFORM_MODEL" });
        const existing = ms.registry.get(req.params.id)!.config;
        const config = await buildUserModel(req.body ?? {}, { existing, id: existing.id });
        const provider = ms.prepareModel(config, "user");
        await t.localStore.saveModel(sealModelConfig(provider.config, t.id));
        t.modelService.publishModel(provider, "user");
        res.json({ model: publicUserModel(provider.config) });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }

    });
  }));

  router.delete("/models/:id", asyncHandler(async (req, res) => {
    const resolved = resolveTenant(req);
    await serializeModelSettings(resolved.modelService, async () => {
      const t = resolved;
      if (customerCatalogEnabled() && !t.modelService.isUserModel(req.params.id)) {
        return res.status(403).json({ error: "ORVYN's models can't be removed.", code: "PLATFORM_MODEL" });
      }
      const wasPreferred = t.modelService.preferredModel === req.params.id;
      if (wasPreferred) {
        await t.localStore.setSetting("preferredModel", "");
        t.modelService.preferredModel = null;
      }
      await t.localStore.deleteModel(req.params.id);
      t.modelService.removeModel(req.params.id);
      res.status(204).end();

    });
  }));

  router.post("/routing", asyncHandler(async (req, res) => {
    const resolved = resolveTenant(req);
    await serializeModelSettings(resolved.modelService, async () => {
      const { task, modelId } = req.body;
      const ms2 = resolved;
      if (customerCatalogEnabled() && !ms2.modelService.isUserModel(String(modelId))) {
        return res.status(403).json({ error: "ORVYN routes its own models. You can route a task to one of your own models.", code: "PLATFORM_MODEL" });
      }
      const provider = ms2.modelService.registry.get(modelId);
      if (!provider) {
        return res.status(400).json({ error: `Unknown model "${modelId}"` });
      }
      // A model that cannot serve the task would break every request for it —
      // reject at the door with the reason rather than letting it poison routing.
      const capability = requiredCapability(task);
      if (!provider.config.capabilities[capability]) {
        return res.status(400).json({
          error: `"${modelId}" cannot handle task "${task}" — it lacks the "${capability}" capability.`,
        });
      }
      const overrides = { ...ms2.modelService.router.getExplicitOverrides(), [task]: modelId };
      // Persist so a restart keeps the user's choices instead of reverting to
      // env defaults (which may point at a dead-credits provider).
      await ms2.localStore.setSetting("routing", JSON.stringify(overrides));
      ms2.modelService.router.setOverride(task, modelId);
      res.json({ overrides: ms2.modelService.router.getOverrides() });

    });
  }));

  router.delete("/routing/:task", asyncHandler(async (req, res) => {
    const resolved = resolveTenant(req);
    await serializeModelSettings(resolved.modelService, async () => {
      const tenant = resolved;
      const ms3 = tenant.modelService;
      const overrides = { ...ms3.router.getExplicitOverrides() } as Record<string, string>;
      delete overrides[req.params.task];
      await tenant.localStore.setSetting("routing", JSON.stringify(overrides));
      ms3.router.clearOverride(req.params.task as any);
      res.json({ overrides: ms3.router.getOverrides() });

    });
  }));
}
