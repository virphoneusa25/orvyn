// apps/backend/src/execution/BrowserProvider.ts
//
// Unified Browser Provider interface for ORVYN.
// Standardizes browser automation across:
// 1. Vercel Cloud MicroVM (agent-browser / CDP / Playwright inside microVM)
// 2. Server-side background browser (Playwright on control plane)
// 3. Desktop Workbench Browser (Electron webview / human-in-the-loop)

export interface BrowserSessionContext {
  runId: string;
  tenantId: string;
  projectId?: string | null;
  surface?: "vercel_cloud" | "workbench" | "background";
  viewport?: { width: number; height: number };
}

export interface NavigationResult {
  ok: boolean;
  url: string;
  title: string;
  status?: number;
  error?: string;
  metaDesc?: string;
  headings?: string[];
  links?: Array<{ text: string; href: string }>;
  bodyText?: string;
}

export interface InteractiveElement {
  ref: string; // e.g. "@e1", "@e2"
  role: string;
  name: string;
  value?: string;
  selector?: string;
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport?: { width: number; height: number };
  accessibilityTree?: string;
  interactiveElements: InteractiveElement[];
  consoleErrors: string[];
  networkErrors: Array<{ method: string; url: string; status: number; error?: string }>;
}

export interface ScreenshotResult {
  ok: boolean;
  screenshotId: string;
  b64?: string;
  mediaType: string;
  width: number;
  height: number;
  sha256?: string;
  error?: string;
}

export type BrowserTarget = string | { x: number; y: number } | { selector: string } | { ref: string };

export interface ActionResult {
  ok: boolean;
  output?: string;
  error?: string;
  currentUrl?: string;
}

export interface BrowserTab {
  id: string | number;
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface ScrollOptions {
  deltaY?: number;
  deltaX?: number;
}

export interface BrowserProvider {
  readonly name: string;
  startSession(context: BrowserSessionContext): Promise<{ ok: boolean; sessionId: string; error?: string }>;
  navigate(url: string, timeoutMs?: number): Promise<NavigationResult>;
  snapshot(interactiveOnly?: boolean): Promise<PageSnapshot>;
  screenshot(fullPage?: boolean): Promise<ScreenshotResult>;
  click(target: BrowserTarget): Promise<ActionResult>;
  fill(target: BrowserTarget, value: string): Promise<ActionResult>;
  scroll(options: ScrollOptions): Promise<ActionResult>;
  getTabs(): Promise<BrowserTab[]>;
  switchTab(index: number): Promise<ActionResult>;
  closeSession(): Promise<void>;
}

/**
 * SSRF and Network Security Guard for Browser Automation.
 * Prevents agents from accessing private network ranges, loopback, or cloud metadata endpoints.
 */
export function validateBrowserUrl(rawUrl: string): { ok: boolean; normalizedUrl: string; error?: string } {
  let trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) {
    return { ok: false, normalizedUrl: "", error: "URL cannot be empty." };
  }

  // Prepend https:// if protocol is omitted
  if (!/^https?:\/\//i.test(trimmed) && !/^file:\/\//i.test(trimmed)) {
    trimmed = "https://" + trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();

    // 1. Block loopback
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost") ||
      host.endsWith(".invalid")
    ) {
      return { ok: false, normalizedUrl: trimmed, error: `Access to loopback target "${host}" is restricted.` };
    }

    // 2. Block Cloud metadata service (AWS/GCP/Azure/OpenStack)
    if (host === "169.254.169.254" || host === "metadata.google.internal") {
      return { ok: false, normalizedUrl: trimmed, error: `Access to cloud metadata service "${host}" is strictly forbidden.` };
    }

    // 3. Block private RFC 1918 subnets (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
    if (
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)
    ) {
      return { ok: false, normalizedUrl: trimmed, error: `Access to private network address "${host}" is restricted.` };
    }

    // 4. Block dangerous protocols
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, normalizedUrl: trimmed, error: `Protocol "${parsed.protocol}" is not supported.` };
    }

    return { ok: true, normalizedUrl: trimmed };
  } catch (err: any) {
    return { ok: false, normalizedUrl: trimmed, error: `Invalid URL format: ${err.message}` };
  }
}
