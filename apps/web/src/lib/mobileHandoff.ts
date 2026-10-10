interface Claim { status: string; token?: string }
interface PollOptions {
  timeoutMs?: number;
  now?: () => number;
  wait?: (signal: AbortSignal) => Promise<void>;
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Sign-in cancelled.", "AbortError");
}
function waitForClaim(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    aborted(signal);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(new DOMException("Sign-in cancelled.", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 1500);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
export async function pollMobileHandoff(claim: () => Promise<Claim>, signal: AbortSignal, options: PollOptions = {}): Promise<string> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 10 * 60_000);
  while (now() < deadline) {
    aborted(signal);
    const result = await claim();
    aborted(signal);
    if (result.status === "ok" && result.token) return result.token;
    if (result.status !== "pending") throw new Error("This sign-in request expired. Try again.");
    await (options.wait ?? waitForClaim)(signal);
  }
  throw new Error("Sign-in took too long. Please try again.");
}
export function mobileOAuthPath(provider: "google" | "github", hid: string, challenge: string): string {
  const query = new URLSearchParams({ client: "mobile", hid, challenge });
  return `/api/v1/auth/oauth/${provider}/start?${query}`;
}
