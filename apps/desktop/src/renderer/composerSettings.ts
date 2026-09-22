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

export interface ComposerDefaults {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  permissionMode: AccessMode;
  mode: string;
}

const DEFAULTS: ComposerDefaults = { modelId: "auto", reasoningEffort: "auto", permissionMode: "auto_read", mode: "auto" };
const KEYS = {
  modelId: "orvyn:run-model",
  reasoningEffort: "orvyn:reasoning",
  permissionMode: "orvyn:access",
  mode: "orvyn:composer-mode",
} as const;

/** Reads the shared user defaults (storage injectable for tests). */
export function readComposerDefaults(storage: Pick<Storage, "getItem"> = localStorage): ComposerDefaults {
  const modelId = storage.getItem(KEYS.modelId)?.trim();
  const reasoning = storage.getItem(KEYS.reasoningEffort)?.trim();
  const access = storage.getItem(KEYS.permissionMode)?.trim();
  const mode = storage.getItem(KEYS.mode)?.trim();
  return {
    modelId: modelId || DEFAULTS.modelId,
    reasoningEffort: (["auto", "fast", "standard", "deep", "max"].includes(reasoning ?? "") ? reasoning : DEFAULTS.reasoningEffort) as ReasoningEffort,
    permissionMode: (["ask", "auto_read", "auto_workspace", "full_access"].includes(access ?? "") ? access : DEFAULTS.permissionMode) as AccessMode,
    mode: mode || DEFAULTS.mode,
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
}): { requestedModelId?: string; reasoningEffort?: ReasoningEffort; permissionMode?: AccessMode } {
  if (!settings) return {};
  return {
    requestedModelId: settings.modelId?.trim() || undefined,
    reasoningEffort: settings.reasoningEffort || undefined,
    permissionMode: settings.permissionMode || undefined,
  };
}

export interface ComposerModeId {
  id: string;
  label: string;
  title: string;
}

/** The six command modes with the shared tooltips both composers show. */
export const COMPOSER_MODES: ComposerModeId[] = [
  { id: "auto", label: "Auto", title: "Auto — ORION classifies the request and picks the pipeline" },
  { id: "code", label: "Code", title: "Code — build, edit, and verify code in the workspace" },
  { id: "server", label: "Server", title: "Server — run on a remote server / OVH worker" },
  { id: "research", label: "Research", title: "Research — read-only investigation, no writes" },
  { id: "deploy", label: "Deploy", title: "Deploy — ship changes" },
  { id: "automate", label: "Automate", title: "Automate — multi-step automation" },
];
