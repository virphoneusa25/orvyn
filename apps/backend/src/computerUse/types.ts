export type ComputerSurface = "auto" | "desktop" | "browser" | "host";
export type ComputerActionName =
  | "screenshot"
  | "click"
  | "type"
  | "scroll"
  | "key"
  | "move"
  | "wait"
  | "open_app"
  | "focus_window";

export interface ComputerUseIdentity {
  tenantId: string;
  userId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  projectRoot: string;
  runId?: string | null;
  desktopSessionId?: string | null;
  browserSessionId?: string | null;
}

export interface ComputerUseRequest {
  action: ComputerActionName;
  identity: ComputerUseIdentity;
  surface?: ComputerSurface;
  sessionId?: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  text?: string;
  key?: string;
  deltaY?: number;
  ms?: number;
  app?: string;
  persist?: boolean;
}

export interface ComputerUseResult {
  ok: boolean;
  output?: string;
  error?: string;
  code?: string;
  desktopHealthy: boolean;
  surface: ComputerSurface | "none";
  sessionId?: string;
  screenshot?: { b64: string; mediaType: string };
}

export interface RuntimeModelCapabilities {
  toolCalling: boolean;
  vision: boolean;
  computerUseViaTools: boolean;
  nativeComputerUse: boolean;
}

export type ProviderErrorCode =
  | "PROVIDER_CAPABILITY_BLOCKED"
  | "PROVIDER_POLICY_RESTRICTION"
  | "PROVIDER_TOOL_NOT_SUPPORTED"
  | "PROVIDER_VISION_UNSUPPORTED";

export interface ProviderCapabilityError {
  code: ProviderErrorCode;
  provider: string;
  capability: "computer_use" | "vision" | "tools";
  retryable: boolean;
  message: string;
  kind: "provider_computer_use_blocked" | "provider_policy_restriction" | "provider_tool_not_supported";
}
