import type { AITool, ToolResult } from "../ai/ToolTypes";
import type { ArtifactService } from "../artifacts/ArtifactService";
import { computerUseCapability } from "./ComputerUseCapability";
import { trustedIdentity } from "./context";
import type { ComputerActionName, ComputerSurface } from "./types";

function toToolResult(result: Awaited<ReturnType<typeof computerUseCapability.act>>, persist?: ArtifactService): ToolResult {
  return {
    ok: result.ok,
    output: result.output,
    error: result.error,
    meta: {
      desktopHealthy: result.desktopHealthy,
      surface: result.surface,
      sessionId: result.sessionId,
      screenshot: result.screenshot,
      persist: Boolean(persist),
    },
  };
}

function makeComputerTool(
  action: ComputerActionName,
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  tenantId: string,
  projectRoot: string,
  artifacts?: ArtifactService
): AITool {
  return {
    name,
    description,
    parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
    defaultPermission: action === "screenshot" || action === "wait" ? "allowed" : "ask",
    async execute(args): Promise<ToolResult> {
      const result = await computerUseCapability.act({
        action,
        identity: trustedIdentity({ tenantId, projectRoot }, typeof args.sessionId === "string" ? args.sessionId : undefined),
        surface: (args.surface as ComputerSurface | undefined) ?? "auto",
        sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
        x: args.x != null ? Number(args.x) : undefined,
        y: args.y != null ? Number(args.y) : undefined,
        button: args.button === "right" || args.button === "middle" ? args.button : "left",
        text: args.text != null ? String(args.text) : undefined,
        key: args.key != null ? String(args.key) : undefined,
        deltaY: args.deltaY != null ? Number(args.deltaY) : undefined,
        ms: args.ms != null ? Number(args.ms) : undefined,
        app: args.app != null ? String(args.app) : undefined,
        persist: args.persist === true,
      });
      if (result.ok && result.screenshot && args.persist === true && artifacts) {
        const bytes = Buffer.from(result.screenshot.b64, "base64");
        const rec = await artifacts.persistArtifact({
          name: `screenshot-${Date.now()}.png`,
          kind: "run",
          bytes,
          mimeType: result.screenshot.mediaType,
          sourceTool: name,
        });
        return {
          ...toToolResult(result, artifacts),
          artifacts: [{
            artifactId: rec.artifactId,
            name: rec.name,
            mimeType: rec.mimeType,
            size: rec.size,
            sha256: rec.sha256,
            kind: "run",
          }],
        };
      }
      return toToolResult(result);
    },
  };
}

export function registerComputerUseTools(
  register: (tool: AITool) => void,
  registerAlias: (alias: string, target: string) => void,
  projectRoot: string,
  tenantId: string,
  artifacts?: ArtifactService
): void {
  const shot = makeComputerTool(
    "screenshot",
    "computer_screenshot",
    "Capture the current Desktop or Browser frame. ORVYN owns this action — do not use a provider-native computer-use API. Prefer this over streaming video.",
    { sessionId: { type: "string" }, surface: { type: "string", enum: ["auto", "desktop", "browser", "host"] }, persist: { type: "boolean" } },
    [],
    tenantId,
    projectRoot,
    artifacts
  );
  register(shot);
  register(makeComputerTool("click", "computer_click", "Click in the visible ORVYN Desktop or Browser session.", {
    sessionId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, surface: { type: "string" },
  }, ["x", "y"], tenantId, projectRoot, artifacts));
  register(makeComputerTool("type", "computer_type", "Type text into the visible session.", {
    sessionId: { type: "string" }, text: { type: "string" }, surface: { type: "string" },
  }, ["text"], tenantId, projectRoot, artifacts));
  register(makeComputerTool("scroll", "computer_scroll", "Scroll the visible session.", {
    sessionId: { type: "string" }, deltaY: { type: "number" }, surface: { type: "string" },
  }, [], tenantId, projectRoot, artifacts));
  register(makeComputerTool("key", "computer_key", "Press a key in the visible session.", {
    sessionId: { type: "string" }, key: { type: "string" }, surface: { type: "string" },
  }, ["key"], tenantId, projectRoot, artifacts));
  register(makeComputerTool("move", "computer_move", "Move the pointer.", {
    sessionId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, surface: { type: "string" },
  }, ["x", "y"], tenantId, projectRoot, artifacts));
  register(makeComputerTool("wait", "computer_wait", "Wait for the UI to settle, then take a new screenshot if needed.", {
    sessionId: { type: "string" }, ms: { type: "number" }, surface: { type: "string" },
  }, [], tenantId, projectRoot, artifacts));
  register(makeComputerTool("open_app", "computer_open_app", "Open a dock app on the Desktop (terminal, files, chromium, editor).", {
    app: { type: "string" }, sessionId: { type: "string" },
  }, ["app"], tenantId, projectRoot, artifacts));
  registerAlias("computer.screenshot", "computer_screenshot");
  registerAlias("computer.click", "computer_click");
  registerAlias("computer.type", "computer_type");
  registerAlias("computer.scroll", "computer_scroll");
  registerAlias("computer.key", "computer_key");
  registerAlias("computer.move", "computer_move");
  registerAlias("computer.wait", "computer_wait");
}

export const COMPUTER_USE_TOOLS = new Set([
  "computer_screenshot",
  "computer_click",
  "computer_type",
  "computer_scroll",
  "computer_key",
  "computer_move",
  "computer_wait",
  "computer_open_app",
  "computer.screenshot",
  "computer.click",
  "computer.type",
  "computer.scroll",
  "computer.key",
  "computer.move",
  "computer.wait",
]);
