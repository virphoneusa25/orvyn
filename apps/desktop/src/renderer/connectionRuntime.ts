// Live account + cloud controller. Panels subscribe; they do not poll their own truth.
import {
  INITIAL_FACTS,
  deriveCloudConnectionState,
  readPersistedProfileName,
  reduceConnection,
  type ConnectionFacts,
} from "./connectionState";
import {
  LOCAL_BACKEND_URL,
  ORVYN_CLOUD_URL,
  apiUrl,
  authHeaders,
  ensureOrchestratorHeartbeat,
  describeTransport,
  getConnectionConfig,
  getOrchestratorStatus,
  isCloudBackend,
  isSessionToken,
  secureBackendUrl,
  loadConnectionConfig,
  noteProtectedStatus,
  onConnectionChange,
  onProtectedStatus,
  resetAuthFailureLatch,
  saveConnectionConfig,
  setOrchestratorStatusHook,
  stopOrchestratorHeartbeat,
  type OrchestratorConnectionState,
} from "./connection";

type Listener = (facts: ConnectionFacts) => void;

let facts: ConnectionFacts = { ...INITIAL_FACTS, profileDisplayName: readPersistedProfileName() };
const listeners = new Set<Listener>();
let validating = false;
let observerInstalled = false;

let activeRunId: string | null = null;

function debugEnabled(): boolean {
  try {
    return localStorage.getItem("orvyn:debug") === "1";
  } catch {
    return false;
  }
}

/** DevTools-only. Hosts and state. Never a token, password, or API key. */
export function logConnectionDiagnostics(): void {
  if (!debugEnabled()) return;
  let transport: ReturnType<typeof describeTransport>;
  try {
    transport = describeTransport(getConnectionConfig().backendUrl);
  } catch {
    return;
  }
  console.info("[orvyn]", {
    ...transport,
    cloudState: deriveCloudConnectionState(facts),
    accountState: facts.accountState,
    workerOnline: facts.workerOnlineCount,
    activeRunId,
    sessionPresent: isSessionToken(getConnectionConfig().apiKey),
  });
}

export function noteActiveRunId(id: string | null): void {
  activeRunId = id;
  logConnectionDiagnostics();
}

function publish(next: ConnectionFacts) {
  facts = next;
  listeners.forEach((l) => l(facts));
  logConnectionDiagnostics();
}

function apply(event: Parameters<typeof reduceConnection>[1]) {
  publish(reduceConnection(facts, event));
}

export function getConnectionFacts(): ConnectionFacts {
  return facts;
}

export function onConnectionFacts(listener: Listener): () => void {
  listeners.add(listener);
  listener(facts);
  return () => listeners.delete(listener);
}

function backendFromSocket(state: OrchestratorConnectionState) {
  apply({ type: "backend", state: state === "online" ? "online" : state === "connecting" ? "connecting" : "offline" });
}

async function refreshWorkers(): Promise<void> {
  if (facts.accountState !== "signed-in") {
    apply({ type: "workers", online: 0 });
    return;
  }
  try {
    const res = await fetch(apiUrl("/worker/list"), { headers: authHeaders() });
    noteProtectedStatus(res.status, res.url || apiUrl("/worker/list"));
    if (!res.ok) return;
    const data = await res.json();
    const online = Array.isArray(data.workers)
      ? data.workers.filter((w: { status?: string }) => w.status && w.status !== "offline").length
      : 0;
    apply({ type: "workers", online });
  } catch {
    // Leave the last count. A failed poll is not "zero workers".
  }
}

async function validateSession(): Promise<void> {
  const cfg = getConnectionConfig();
  const hasSession = isSessionToken(cfg.apiKey);
  apply({ type: "config", cloudTarget: isCloudBackend(cfg.backendUrl), hasSession });
  if (!hasSession) return;
  if (validating) return;
  validating = true;
  try {
    const res = await fetch(apiUrl("/auth/me"), { headers: authHeaders() });
    if (res.status === 401 || res.status === 403) {
      noteProtectedStatus(res.status, res.url || apiUrl("/auth/me"));
      apply({ type: "session-invalid" });
      stopOrchestratorHeartbeat();
      return;
    }
    if (!res.ok) {
      apply({ type: "backend", state: "offline" });
      return;
    }
    const data = await res.json();
    const user = data.user ?? {};
    apply({
      type: "session-valid",
      name: user.name ? String(user.name) : null,
      email: user.email ? String(user.email) : null,
    });
    if (getOrchestratorStatus() === "online") apply({ type: "backend", state: "online" });
    await refreshWorkers();
  } catch {
    apply({ type: "backend", state: "offline" });
  } finally {
    validating = false;
  }
}

export interface CloudSignInInput {
  backendUrl?: string;
  email: string;
  password: string;
  name?: string;
  mode: "login" | "register";
}

export async function signInWithCredentials(
  input: CloudSignInInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  let base: string;
  try {
    base = secureBackendUrl(input.backendUrl?.trim() || ORVYN_CLOUD_URL);
  } catch (err: any) {
    return { ok: false, error: err?.message || "Cloud Mode requires https" };
  }
  const path = input.mode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login";
  const body: Record<string, string> = { email: input.email.trim(), password: input.password };
  if (input.mode === "register" && input.name?.trim()) body.name = input.name.trim();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "Could not reach ORVYN Cloud" };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  resetAuthFailureLatch();
  await saveConnectionConfig({ backendUrl: base, apiKey: String(data.token) });
  ensureOrchestratorHeartbeat();
  await validateSession();
  return { ok: true };
}

export async function signOutOfCloud(): Promise<void> {
  const cfg = getConnectionConfig();
  try {
    if (isSessionToken(cfg.apiKey)) {
      await fetch(apiUrl("/auth/logout"), { method: "POST", headers: authHeaders() });
    }
  } catch {
    // Revocation is best-effort. Local projects and chat history stay.
  }
  resetAuthFailureLatch();
  apply({ type: "signed-out" });
  await saveConnectionConfig({ backendUrl: LOCAL_BACKEND_URL, apiKey: "" });
  ensureOrchestratorHeartbeat();
}

export async function continueInLocalMode(): Promise<void> {
  resetAuthFailureLatch();
  apply({ type: "signed-out" });
  await saveConnectionConfig({ backendUrl: LOCAL_BACKEND_URL, apiKey: "" });
  ensureOrchestratorHeartbeat();
}

export function noteWorkspaceName(name: string | null): void {
  apply({ type: "workspace", name });
}

export function noteLocalIdentity(name: string): void {
  apply({ type: "identity", name });
}

export function noteLocalEngine(state: "ready" | "degraded" | "offline"): void {
  apply({ type: "local-engine", state });
}

function installFetchObserver(): void {
  if (observerInstalled || typeof window === "undefined" || typeof window.fetch !== "function") return;
  observerInstalled = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const base = getConnectionConfig().backendUrl.replace(/\/$/, "");
      if (url.startsWith(base)) noteProtectedStatus(res.status, url);
    } catch {
      /* observer must not break the caller */
    }
    return res;
  };
}

export function startConnectionRuntime(): () => void {
  installFetchObserver();
  onProtectedStatus(() => {
    apply({ type: "session-invalid" });
    stopOrchestratorHeartbeat();
  });
  setOrchestratorStatusHook((state) => {
    backendFromSocket(state);
    if (state === "online" && facts.accountState === "signed-in") void refreshWorkers();
  });
  const offConfig = onConnectionChange(() => {
    void validateSession();
  });
  void (async () => {
    try {
      const identity = await window.orvyn.system.getIdentity?.();
      if (identity?.name) noteLocalIdentity(identity.name);
    } catch {
      /* identity is optional */
    }
    await loadConnectionConfig();
    await validateSession();
    ensureOrchestratorHeartbeat();
  })();
  const timer = setInterval(() => {
    if (facts.accountState === "signed-in" && facts.backendState === "online") void refreshWorkers();
  }, 10000);
  return () => {
    clearInterval(timer);
    offConfig();
    setOrchestratorStatusHook(null);
    onProtectedStatus(null);
    stopOrchestratorHeartbeat();
  };
}
