import { api } from "./api";
import { apiUrl, mobilePlatform } from "./mobilePlatform";
import { mobileOAuthPath, pollMobileHandoff } from "./mobileHandoff";

function b64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomId(length: number): string { return b64url(crypto.getRandomValues(new Uint8Array(length))); }
/** Reuse the Desktop verifier-bound one-time handoff. No token/verifier in the browser URL. */
export async function mobileSignIn(provider: "google" | "github", signal: AbortSignal): Promise<string> {
  const mobile = mobilePlatform();
  if (!mobile) throw new Error("Native sign-in is unavailable.");
  const hid = randomId(24), verifier = randomId(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  if (signal.aborted) throw new DOMException("Sign-in cancelled.", "AbortError");
  const url = apiUrl(mobileOAuthPath(provider, hid, b64url(new Uint8Array(digest))));
  await mobile.openBrowser(url);
  try {
    return await pollMobileHandoff(() => api<{ status: string; token?: string }>("/auth/handoff/claim", { method: "POST", body: { hid, verifier, device: "ORVYN Mobile" }, signal }), signal);
  } finally {
    await mobile.closeBrowser().catch(() => undefined);
  }
}
