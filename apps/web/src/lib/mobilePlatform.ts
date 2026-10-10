/** Injected only by the native shell before mounting the existing portal. */
export interface MobilePlatform {
  apiOrigin: string;
  openBrowser: (url: string) => Promise<void>;
  closeBrowser: () => Promise<void>;
  saveFile: (blob: Blob, name: string) => Promise<void>;
}
declare global {
  interface Window { orvynMobile?: MobilePlatform }
}

export function validatedMobileOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The mobile API must be a trusted HTTPS origin without a path or credentials.");
  }
  return url.origin;
}
export function mobilePlatform(): MobilePlatform | undefined {
  return typeof window === "undefined" ? undefined : window.orvynMobile;
}

/** Browser requests remain relative; the bundled native UI uses the cloud origin. */
export function resolveApiUrl(path: string, origin?: string): string {
  return origin ? new URL(path, validatedMobileOrigin(origin)).href : path;
}
export function apiUrl(path: string): string {
  return resolveApiUrl(path, mobilePlatform()?.apiOrigin);
}
export function resolveSocketUrl(origin: string, ticket: string): string {
  const url = new URL("/ws/chat", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.href;
}
export function chatSocketUrl(ticket: string): string {
  return resolveSocketUrl(mobilePlatform()?.apiOrigin ?? location.origin, ticket);
}
