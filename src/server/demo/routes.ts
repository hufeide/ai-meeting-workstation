import { Router } from "express";
import { customerProfileSchema, routeIdSchema } from "../../shared/schemas";
import type { LocalSettingsStore } from "../settings/localSettings";
import type { MemoryStore } from "../memory/memoryStore";
import type { DemoWorkspace } from "./demoWorkspace";

export function createDemoRouter(deps: {
  workspace: DemoWorkspace;
  memoryStore: MemoryStore;
  settingsStore: LocalSettingsStore;
}): Router {
  const router = Router();

  router.post("/bootstrap", (_request, response) => {
    response.json(deps.workspace.bootstrap());
  });

  router.post("/reset", (_request, response) => {
    try {
      response.json(deps.workspace.reset());
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "演示空间暂时无法重置。" });
    }
  });

  router.post("/discussions/:id/fallback-audio", async (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      response.status(201).json(await deps.workspace.loadFallbackAudio(parsed.data.id));
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "载入演示兜底录音失败。" });
    }
  });

  router.get("/customers", (_request, response) => {
    response.json(deps.memoryStore.listCustomers());
  });

  router.get("/customers/:id", (request, response) => {
    try {
      response.json(deps.memoryStore.getCustomer(request.params.id, deps.settingsStore.load().recentMemoryCount));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "演示客户不存在。" });
    }
  });

  router.post("/customers", (request, response) => {
    const parsed = customerProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      response.status(201).json(deps.memoryStore.saveCustomer(parsed.data));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "保存演示客户档案失败。" });
    }
  });

  return router;
}
