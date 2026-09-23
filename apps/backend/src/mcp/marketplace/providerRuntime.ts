// Isolated catalog-provider I/O. Each registry call owns its AbortController.
// A timeout/5xx here must never abort sibling providers.

export const PROVIDER_TIMEOUTS_MS = {
  official: 12_000,
  glama: 10_000,
  smithery: 10_000,
  private: 10_000,
  local: 2_000,
} as const;

export type CatalogErrorClass =
  | "timeout"
  | "network"
  | "http-5xx"
  | "rate-limited"
  | "auth-required"
  | "permission-denied"
  | "html"
  | "invalid-json"
  | "not-found"
  | "route-incompatible"
  | "needs-key"
  | "disabled"
  | "unknown";

export type ProviderHealthStatus =
  | "online"
  | "slow"
  | "auth-required"
  | "rate-limited"
  | "offline"
  | "error"
  | "disabled"
  | "needs-key";

export class CatalogProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly errorClass: CatalogErrorClass,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "CatalogProviderError";
  }
}

export function shouldRetry(errorClass: CatalogErrorClass): boolean {
  return errorClass === "timeout" || errorClass === "network" || errorClass === "http-5xx";
}

export function classifyHttpStatus(status: number, html = false): CatalogErrorClass {
  if (html && (status === 404 || status === 200 || status >= 500)) return "route-incompatible";
  if (html) return "html";
  if (status === 401) return "auth-required";
  if (status === 403) return "permission-denied";
  if (status === 429) return "rate-limited";
  if (status === 404) return "not-found";
  if (status >= 500) return "http-5xx";
  return "unknown";
}

export function healthFromErrorClass(errorClass: CatalogErrorClass | undefined, latencyMs?: number, timeoutMs?: number): ProviderHealthStatus {
  if (!errorClass) {
    if (timeoutMs && latencyMs != null && latencyMs >= timeoutMs * 0.7) return "slow";
    return "online";
  }
  if (errorClass === "timeout") return "slow";
  if (errorClass === "needs-key") return "needs-key";
  if (errorClass === "disabled") return "disabled";
  if (errorClass === "auth-required") return "auth-required";
  if (errorClass === "rate-limited") return "rate-limited";
  if (errorClass === "network" || errorClass === "http-5xx") return "offline";
  return "error";
}

export function classifyThrown(err: unknown, provider: string): CatalogProviderError {
  if (err instanceof CatalogProviderError) return err;
  const message = String((err as { message?: string })?.message ?? err);
  if ((err as { name?: string })?.name === "AbortError" || /aborted|timeout/i.test(message)) {
    return new CatalogProviderError(provider, "timeout", message.slice(0, 180));
  }
  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(message)) {
    return new CatalogProviderError(provider, "network", message.slice(0, 180));
  }
  if (/Unexpected token '<'|is not valid JSON|JSON\.parse/i.test(message)) {
    return new CatalogProviderError(provider, "invalid-json", "Registry returned non-JSON");
  }
  return new CatalogProviderError(provider, "unknown", message.slice(0, 180));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryBackoffMs(): number {
  return 180 + Math.floor(Math.random() * 320);
}

export async function withProviderTimeout<T>(work: Promise<T>, timeoutMs: number, provider: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CatalogProviderError(provider, "timeout", `${provider} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function retryIdempotent<T>(fn: () => Promise<T>, provider: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const classified = classifyThrown(err, provider);
    if (!shouldRetry(classified.errorClass)) throw classified;
    await sleep(retryBackoffMs());
    try {
      return await fn();
    } catch (again) {
      throw classifyThrown(again, provider);
    }
  }
}

export function parseRetryAfter(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10 * 60 * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 10 * 60 * 1000));
  return undefined;
}

export type CatalogFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text?: () => Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export async function fetchCatalogJson(input: {
  url: string;
  provider: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  fetchImpl?: CatalogFetch;
  retry?: boolean;
}): Promise<{ status: number; body: any }> {
  const fetchImpl = input.fetchImpl ?? (fetch as CatalogFetch);
  const started = Date.now();
  const run = async () => {
    const leftover = Math.max(150, input.timeoutMs - (Date.now() - started));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), leftover);
    try {
      const res = await fetchImpl(input.url, {
        headers: { Accept: "application/json", ...input.headers },
        signal: ac.signal,
      });
      const contentType = res.headers?.get?.("content-type") ?? "";
      let text = "";
      if (typeof res.text === "function") {
        text = await res.text();
      } else {
        try {
          const body = await res.json();
          text = JSON.stringify(body ?? {});
        } catch {
          text = "";
        }
      }
      const html = /^\s*</.test(text) || /text\/html/i.test(contentType);
      if (html) {
        throw new CatalogProviderError(
          input.provider,
          classifyHttpStatus(res.status, true),
          `${input.provider} returned HTML (HTTP ${res.status})`,
          res.status
        );
      }
      let body: any = {};
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new CatalogProviderError(input.provider, "invalid-json", `${input.provider} returned non-JSON`, res.status);
        }
      }
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 404 || res.status >= 500 || !res.ok) {
        throw new CatalogProviderError(
          input.provider,
          classifyHttpStatus(res.status),
          `${input.provider} HTTP ${res.status}`,
          res.status,
          parseRetryAfter(res.headers?.get?.("retry-after") ?? null)
        );
      }
      return { status: res.status, body };
    } catch (err) {
      throw classifyThrown(err, input.provider);
    } finally {
      clearTimeout(timer);
    }
  };
  if (input.retry === false) return run();
  return retryIdempotent(run, input.provider);
}

export function logProviderFailure(input: {
  provider: string;
  query: string;
  duration: number;
  status?: number;
  errorClass: CatalogErrorClass;
}): void {
  console.info(
    JSON.stringify({
      event: "mcp.catalog.provider",
      provider: input.provider,
      query: String(input.query ?? "").slice(0, 80),
      duration: input.duration,
      status: input.status ?? 0,
      errorClass: input.errorClass,
    })
  );
}
