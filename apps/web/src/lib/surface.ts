import { getViewAsToken } from "./api";

// Which web surface this page is: the customer portal (app host) or the staff
// Admin Portal (admin host). The server stamps it into the page by host.

const meta = (name: string) => (typeof document !== "undefined" ? document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "" : "");

export const surface: "app" | "admin" = meta("orvyn-surface") === "admin" ? "admin" : "app";
export const appHost = meta("orvyn-app-host");
export const adminHost = meta("orvyn-admin-host");

function originOf(host: string): string {
  return `${location.protocol}//${host}${location.port && !["80", "443"].includes(location.port) ? `:${location.port}` : ""}`;
}

/** Where the Admin Portal is (its own host in production; /admin locally). */
export function adminUrl(path = "/admin"): string {
  return adminHost && location.hostname !== adminHost ? `${originOf(adminHost)}${path}` : path;
}
/** Where the customer portal is. */
export function appUrl(path = "/"): string {
  return appHost && location.hostname !== appHost ? `${originOf(appHost)}${path}` : path;
}

/** On the admin host every page is an admin page (except sign-in and a support view tab). */
export function normalizeAdminPath(): void {
  if (surface !== "admin" || getViewAsToken()) return;
  const p = location.pathname;
  if (p.startsWith("/admin") || p === "/signin" || p === "/view-as") return;
  history.replaceState(null, "", `/admin${p === "/" ? "" : p}${location.search}${location.hash}`);
}
