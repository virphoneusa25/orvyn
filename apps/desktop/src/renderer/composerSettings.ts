// apps/desktop/src/renderer/composerSettings.ts
//
// The ONE composer settings model shared by the chat composer and the Home
// "new mission" composer: user defaults (localStorage keys), the six command
// modes, and the mapping onto run-payload fields. Plain .ts so the logic is
// directly unit-testable.

export type ReasoningEffort = "auto" | "fast" | "standard" | "deep" | "max";
export type AccessMode = "ask" | "auto_read" | "auto_workspace" | "full_access";

// ── Shared settings model ───────────────────────────────────────────────────
// ONE defaults model for both composer contexts (chat + Home "new mission"):
// conversation setting (chat only) → user default (these keys) → Auto.

export type ExecutionTargetSetting = "auto" | "local_host" | "local_sandbox" | "ovh_worker";

export interface ComposerDefaults {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  permissionMode: AccessMode;
  mode: string;
  executionTarget: ExecutionTargetSetting;
}

const DEFAULTS: ComposerDefaults = { modelId: "auto", reasoningEffort: "auto", permissionMode: "auto_read", mode: "auto", executionTarget: "auto" };
const KEYS = {
  modelId: "orvyn:run-model",
  reasoningEffort: "orvyn:reasoning",
  permissionMode: "orvyn:access",
  mode: "orvyn:composer-mode",
  executionTarget: "orvyn:execution-target",
} as const;

/** Reads the shared user defaults (storage injectable for tests). */
export function readComposerDefaults(storage: Pick<Storage, "getItem"> = localStorage): ComposerDefaults {
  const modelId = storage.getItem(KEYS.modelId)?.trim();
  const reasoning = storage.getItem(KEYS.reasoningEffort)?.trim();
  const access = storage.getItem(KEYS.permissionMode)?.trim();
  const mode = storage.getItem(KEYS.mode)?.trim();
  const executionTarget = storage.getItem(KEYS.executionTarget)?.trim();
  return {
    modelId: modelId || DEFAULTS.modelId,
    reasoningEffort: (["auto", "fast", "standard", "deep", "max"].includes(reasoning ?? "") ? reasoning : DEFAULTS.reasoningEffort) as ReasoningEffort,
    permissionMode: (["ask", "auto_read", "auto_workspace", "full_access"].includes(access ?? "") ? access : DEFAULTS.permissionMode) as AccessMode,
    mode: mode || DEFAULTS.mode,
    executionTarget: (["auto", "local_host", "local_sandbox", "ovh_worker"].includes(executionTarget ?? "")
      ? executionTarget
      : DEFAULTS.executionTarget) as ExecutionTargetSetting,
  };
}

/** Persists one user default (both composers call this — no second path). */
export function writeComposerDefault<K extends keyof ComposerDefaults>(key: K, value: ComposerDefaults[K]): void {
  localStorage.setItem(KEYS[key], String(value));
}

/** Normalizes composer settings onto the submitOrvynCommand payload fields. */
export function toRunPayloadSettings(settings?: {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode?: AccessMode;
  executionTarget?: ExecutionTargetSetting;
}): { requestedModelId?: string; reasoningEffort?: ReasoningEffort; permissionMode?: AccessMode; executionTarget?: ExecutionTargetSetting } {
  if (!settings) return {};
  const payload: { requestedModelId?: string; reasoningEffort?: ReasoningEffort; permissionMode?: AccessMode; executionTarget?: ExecutionTargetSetting } = {
    requestedModelId: settings.modelId?.trim() || undefined,
    reasoningEffort: settings.reasoningEffort || undefined,
    permissionMode: settings.permissionMode || undefined,
  };
  if (settings.executionTarget) payload.executionTarget = settings.executionTarget;
  return payload;
}

export const EXECUTION_TARGETS: { id: ExecutionTargetSetting; label: string; title: string }[] = [
  { id: "auto", label: "Auto", title: "Auto — Local for normal coding, Sandbox for risky commands, Cloud for Server/Deploy" },
  { id: "local_host", label: "Local", title: "Local — tools run on this machine, nothing is uploaded" },
  { id: "local_sandbox", label: "Sandbox", title: "Sandbox — isolated Docker on this machine" },
  { id: "ovh_worker", label: "Cloud", title: "Cloud — ORVYN Cloud. Never silently switched to Local." },
];

export interface ComposerModeId {
  id: string;
  label: string;
  title: string;
}

/** The six command modes with the shared tooltips both composers show. */
export const COMPOSER_MODES: ComposerModeId[] = [
  { id: "auto", label: "Auto", title: "Auto — ORION classifies the request and picks the pipeline" },
  { id: "code", label: "Code", title: "Code — build, edit, and verify code in the workspace" },
  { id: "server", label: "Server", title: "Server — run on a remote server or ORVYN Cloud" },
  { id: "research", label: "Research", title: "Research — read-only investigation, no writes" },
  { id: "deploy", label: "Deploy", title: "Deploy — ship changes" },
  { id: "automate", label: "Automate", title: "Automate — multi-step automation" },
];

/** Toolbar label: "Cheaper Inference glm-5.3" → "GLM-5.3". Identity (id) is unchanged. */
export function compactModelLabel(name?: string | null, id?: string | null): string {
  const modelId = (id ?? "").trim();
  if (!modelId || modelId === "auto") return "Auto";
  const display = (name ?? "").trim();
  const haystack = `${display} ${modelId}`;
  const token = haystack.match(
    /(?:^|[\s/:._-])((?:glm|gpt|o\d|claude|gemini|llama|mistral|qwen|deepseek|grok|phi|nemotron)[-.\w]*)/i
  );
  if (token?.[1]) return formatModelToken(token[1]);
  const tail = modelId.split(/[/:]/).pop() ?? modelId;
  if (tail && tail.length <= 18) return formatModelToken(tail);
  const stripped = display.replace(/^(cheaper|fast|premium|best|default|budget|pro)\s+inference\s+/i, "").trim();
  if (stripped) return stripped.length <= 18 ? formatModelToken(stripped) : stripped.slice(0, 16);
  return (display || modelId).slice(0, 16);
}

function formatModelToken(raw: string): string {
  return raw.replace(/\s+/g, "-").replace(/[a-z]+/gi, (part) => part.toUpperCase());
}
