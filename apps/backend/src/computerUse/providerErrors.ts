import type { ProviderCapabilityError, ProviderErrorCode } from "./types";

const BLOCKED = /computer[- ]use is blocked|computer use is blocked on|blocked on claude usage|computer[- ]use (is )?(not (available|supported|allowed)|disabled|restricted)|anthropic.*computer[_ ]use|native computer use/i;
const POLICY = /policy restriction|usage policy|refused to (control|operate) (the )?(computer|desktop)|i (cannot|can't) (control|use|operate) (the )?(computer|desktop|screen)/i;
const TOOL = /tool (is )?not supported|unknown tool|does not support tools|function calling (is )?(not |un)supported/i;
const VISION = /does not support (vision|images)|no vision capability|cannot (inspect|see|view) (images|screenshots)/i;

export function classifyProviderError(err: unknown, provider = "unknown"): ProviderCapabilityError | null {
  const message = String((err as Error)?.message ?? err ?? "");
  if (!message.trim()) return null;
  if (BLOCKED.test(message)) {
    return pack("PROVIDER_CAPABILITY_BLOCKED", provider, "computer_use", "provider_computer_use_blocked", message, false);
  }
  if (POLICY.test(message)) {
    return pack("PROVIDER_POLICY_RESTRICTION", provider, "computer_use", "provider_policy_restriction", message, false);
  }
  if (VISION.test(message)) {
    return pack("PROVIDER_VISION_UNSUPPORTED", provider, "vision", "provider_tool_not_supported", message, false);
  }
  if (TOOL.test(message)) {
    return pack("PROVIDER_TOOL_NOT_SUPPORTED", provider, "tools", "provider_tool_not_supported", message, false);
  }
  return null;
}

export function classifyProviderText(text: string, provider = "unknown"): ProviderCapabilityError | null {
  return classifyProviderError(new Error(text), provider);
}

function pack(
  code: ProviderErrorCode,
  provider: string,
  capability: ProviderCapabilityError["capability"],
  kind: ProviderCapabilityError["kind"],
  message: string,
  retryable: boolean
): ProviderCapabilityError {
  return { code, provider, capability, retryable, message: message.slice(0, 400), kind };
}

export function providerBlockUserMessage(err: ProviderCapabilityError, pinned: boolean): string {
  const model = err.provider;
  if (err.capability === "vision") {
    return pinned
      ? `Selected model cannot inspect images. Visual verification was not faked.`
      : `Selected model cannot inspect images.`;
  }
  if (pinned) {
    return `Selected model cannot perform computer-use for this request (${model}). Desktop is still available — choose a model with tools, or switch to Auto.`;
  }
  return `Model · ${model} cannot use computer control here`;
}
