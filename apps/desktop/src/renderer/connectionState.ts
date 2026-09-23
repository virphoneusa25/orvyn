// Single source of truth for how the desktop describes account + cloud.
// Sidebar, title bar, status bar, and the Home hero all render this model.
// They do not invent their own "Synced" / "Online" interpretations.

export type AccountState = "signed-out" | "signed-in" | "expired";
export type BackendState = "offline" | "connecting" | "online";
export type SyncState = "idle" | "syncing" | "synced" | "error";
export type LocalEngineState = "ready" | "degraded" | "offline";

export type CloudConnectionState =
  | "signed-out"
  | "local"
  | "connecting"
  | "cloud-online"
  | "cloud-synced"
  | "cloud-offline"
  | "session-expired";

export interface ConnectionFacts {
  accountState: AccountState;
  backendState: BackendState;
  workerOnlineCount: number;
  syncState: SyncState;
  localEngineState: LocalEngineState;
  /** Configured backend host is not localhost. */
  cloudTarget: boolean;
  /** User is on the local engine (no cloud session in force). */
  localMode: boolean;
  accountName: string | null;
  accountEmail: string | null;
  /** Real org/workspace name. Null when the product has no org record. */
  workspaceName: string | null;
  /** OS / local profile name. Empty until the shell reports one. */
  localDisplayName: string;
  /** Last known cloud/account display name. Survives local-mode sign-out. */
  profileDisplayName: string;
}

export const INITIAL_FACTS: ConnectionFacts = {
  accountState: "signed-out",
  backendState: "offline",
  workerOnlineCount: 0,
  syncState: "idle",
  localEngineState: "ready",
  cloudTarget: false,
  localMode: true,
  accountName: null,
  accountEmail: null,
  workspaceName: null,
  localDisplayName: "",
  profileDisplayName: "",
};

export const PROFILE_DISPLAY_NAME_KEY = "orvyn:profile-display-name";

export function readPersistedProfileName(storage?: Pick<Storage, "getItem"> | null): string {
  try {
    const store = storage ?? (typeof globalThis !== "undefined" ? globalThis.localStorage : undefined);
    return String(store?.getItem(PROFILE_DISPLAY_NAME_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

export function persistProfileName(name: string, storage?: Pick<Storage, "setItem"> | null): void {
  const n = name.trim();
  if (!n) return;
  try {
    const store = storage ?? (typeof globalThis !== "undefined" ? globalThis.localStorage : undefined);
    store?.setItem(PROFILE_DISPLAY_NAME_KEY, n);
  } catch {
    /* private mode / node tests */
  }
}

export type RuntimeEvent =
  | { type: "config"; cloudTarget: boolean; hasSession: boolean }
  | { type: "session-valid"; name: string | null; email: string | null }
  | { type: "session-invalid" }
  | { type: "signed-out" }
  | { type: "backend"; state: BackendState }
  | { type: "workers"; online: number }
  | { type: "local-engine"; state: LocalEngineState }
  | { type: "identity"; name: string }
  | { type: "workspace"; name: string | null };

export function reduceConnection(facts: ConnectionFacts, event: RuntimeEvent): ConnectionFacts {
  switch (event.type) {
    case "identity":
      return { ...facts, localDisplayName: event.name };
    case "workspace":
      return { ...facts, workspaceName: event.name };
    case "local-engine":
      return { ...facts, localEngineState: event.state };
    case "signed-out":
      return {
        ...INITIAL_FACTS,
        localDisplayName: facts.localDisplayName,
        profileDisplayName: facts.profileDisplayName || readPersistedProfileName(),
        localEngineState: facts.localEngineState === "offline" ? "ready" : facts.localEngineState,
        workspaceName: facts.workspaceName,
      };
    case "config": {
      if (!event.hasSession) {
        return {
          ...facts,
          cloudTarget: event.cloudTarget,
          localMode: !event.cloudTarget,
          accountState: "signed-out",
          accountName: null,
          accountEmail: null,
          syncState: "idle",
          workerOnlineCount: 0,
          backendState: "offline",
        };
      }
      return {
        ...facts,
        cloudTarget: event.cloudTarget,
        localMode: false,
        syncState: "syncing",
        backendState: facts.backendState === "online" ? "online" : "connecting",
        workerOnlineCount: facts.accountState === "signed-in" ? facts.workerOnlineCount : 0,
      };
    }
    case "session-valid": {
      const named = event.name?.trim() || "";
      if (named) persistProfileName(named);
      else if (event.email?.trim()) persistProfileName(event.email.trim().split("@")[0] ?? "");
      return {
        ...facts,
        accountState: "signed-in",
        accountName: event.name,
        accountEmail: event.email,
        profileDisplayName: named || facts.profileDisplayName || readPersistedProfileName(),
        localMode: false,
        syncState: facts.backendState === "online" && facts.syncState === "synced" ? "synced" : "syncing",
      };
    }
    case "session-invalid":
      return {
        ...facts,
        accountState: "expired",
        syncState: "error",
        backendState: "offline",
        workerOnlineCount: 0,
        localMode: false,
      };
    case "backend": {
      if (facts.accountState === "expired") {
        return { ...facts, backendState: "offline" };
      }
      if (facts.accountState !== "signed-in") {
        // A localhost socket coming up is the local engine, not ORVYN Cloud.
        if (!facts.cloudTarget || facts.localMode) return { ...facts, backendState: "offline" };
        return { ...facts, backendState: event.state === "online" ? "connecting" : event.state };
      }
      if (event.state === "online") {
        return {
          ...facts,
          backendState: "online",
          syncState: facts.syncState === "error" ? "syncing" : facts.syncState,
        };
      }
      if (event.state === "connecting") return { ...facts, backendState: "connecting" };
      return {
        ...facts,
        backendState: "offline",
        syncState: facts.syncState === "synced" ? "error" : facts.syncState,
      };
    }
    case "workers": {
      const online = Math.max(0, Math.floor(event.online));
      if (facts.accountState === "signed-in" && facts.backendState === "online") {
        return { ...facts, workerOnlineCount: online, syncState: "synced" };
      }
      return { ...facts, workerOnlineCount: facts.accountState === "signed-in" ? online : 0 };
    }
    default:
      return facts;
  }
}

export function deriveCloudConnectionState(facts: ConnectionFacts): CloudConnectionState {
  if (facts.accountState === "expired") return "session-expired";
  if (facts.accountState !== "signed-in") {
    if ((facts.syncState === "syncing" || facts.backendState === "connecting") && (facts.cloudTarget || !facts.localMode)) {
      return "connecting";
    }
    if (facts.localMode || !facts.cloudTarget) return "local";
    return "signed-out";
  }
  if (facts.backendState === "offline") return "cloud-offline";
  if (facts.backendState === "connecting") return "connecting";
  if (facts.syncState === "synced") return "cloud-synced";
  return "cloud-online";
}

export interface StatusIndicator {
  label: string;
  tone: "on" | "off" | "pending";
}

export interface ConnectionPresentation {
  state: CloudConnectionState;
  titlePrimary: string;
  titleSecondary: string;
  showTitleDot: boolean;
  titleDot: "on" | "off" | "pending";
  userName: string;
  userSubtitle: string;
  indicators: StatusIndicator[];
  modeLabel: "Local" | "Cloud";
  menuStatus: string;
  workspaceLabel: string;
  signedIn: boolean;
  accountEmail: string | null;
  /** Backend health, account session, and worker availability stay separate. */
  statusFacts: { backend: string; account: string; worker: string };
}

function personName(facts: ConnectionFacts): string {
  if (facts.accountState === "signed-in" || facts.accountState === "expired") {
    const named = facts.accountName?.trim();
    if (named) return named;
    const email = facts.accountEmail?.trim();
    if (email) return email.split("@")[0] || email;
  }
  const profile = (facts.profileDisplayName || readPersistedProfileName()).trim();
  if (profile) return profile;
  const local = facts.localDisplayName.trim();
  return local || "You";
}

function workspaceLabel(facts: ConnectionFacts): string {
  const name = facts.workspaceName?.trim();
  return name || "Local workspace";
}

function engineIndicator(facts: ConnectionFacts): StatusIndicator {
  if (facts.localEngineState === "ready") return { label: "Local Engine Ready", tone: "on" };
  if (facts.localEngineState === "degraded") return { label: "Local Engine Degraded", tone: "pending" };
  return { label: "Local Engine Offline", tone: "off" };
}

function statusFacts(facts: ConnectionFacts): ConnectionPresentation["statusFacts"] {
  const state = deriveCloudConnectionState(facts);
  const backend =
    state === "cloud-synced" || state === "cloud-online"
      ? "Online"
      : state === "connecting"
        ? "Connecting"
        : facts.localEngineState === "ready" && (state === "local" || state === "signed-out")
          ? "Local"
          : "Offline";
  const account =
    facts.accountState === "signed-in" ? "Signed in" : facts.accountState === "expired" ? "Session expired" : "Signed out";
  const worker = facts.workerOnlineCount >= 1 ? `${facts.workerOnlineCount} online` : "none";
  return { backend, account, worker };
}

function workerIndicator(facts: ConnectionFacts): StatusIndicator | null {
  if (facts.workerOnlineCount < 1) return null;
  const n = facts.workerOnlineCount;
  return { label: `${n} worker${n === 1 ? "" : "s"} online`, tone: "on" };
}

export function describeConnection(facts: ConnectionFacts): ConnectionPresentation {
  const state = deriveCloudConnectionState(facts);
  const name = personName(facts);
  const workspace = workspaceLabel(facts);
  const signedIn = facts.accountState === "signed-in";
  const base = {
    state,
    userName: name,
    workspaceLabel: workspace,
    signedIn,
    accountEmail: facts.accountEmail,
    statusFacts: statusFacts(facts),
  };

  switch (state) {
    case "connecting":
      return {
        ...base,
        titlePrimary: "ORVYN Cloud",
        titleSecondary: "Connecting…",
        showTitleDot: false,
        titleDot: "pending",
        userSubtitle: "Connecting to cloud",
        indicators: [engineIndicator(facts), { label: "ORVYN Cloud Connecting", tone: "pending" }],
        modeLabel: "Cloud",
        menuStatus: "Connecting to ORVYN Cloud",
      };
    case "cloud-online":
      return {
        ...base,
        titlePrimary: "ORVYN Cloud",
        titleSecondary: name,
        showTitleDot: true,
        titleDot: "on",
        userSubtitle: "Connected",
        indicators: [{ label: "ORVYN Cloud Connected", tone: "on" }, engineIndicator(facts)],
        modeLabel: "Cloud",
        menuStatus: "Cloud connected",
      };
    case "cloud-synced": {
      const worker = workerIndicator(facts);
      const indicators: StatusIndicator[] = [
        { label: "ORVYN Cloud Connected", tone: "on" },
        { label: "Synced", tone: "on" },
      ];
      if (worker) indicators.push(worker);
      return {
        ...base,
        titlePrimary: "ORVYN Cloud",
        titleSecondary: name,
        showTitleDot: true,
        titleDot: "on",
        userSubtitle: "Synced",
        indicators,
        modeLabel: "Cloud",
        menuStatus: "Cloud connected",
      };
    }
    case "cloud-offline":
      return {
        ...base,
        titlePrimary: "ORVYN Cloud",
        titleSecondary: "Offline",
        showTitleDot: false,
        titleDot: "off",
        userSubtitle: "Cloud offline",
        indicators: [
          { label: "ORVYN Cloud Offline", tone: "off" },
          engineIndicator(facts),
        ],
        modeLabel: "Cloud",
        menuStatus: "Cloud offline",
      };
    case "session-expired":
      return {
        ...base,
        titlePrimary: "Session expired",
        titleSecondary: "Sign in again →",
        showTitleDot: false,
        titleDot: "off",
        userSubtitle: "Session expired",
        indicators: [
          { label: "Cloud authentication required", tone: "off" },
          engineIndicator(facts),
        ],
        modeLabel: "Local",
        menuStatus: "Session expired",
      };
    case "signed-out":
    case "local":
    default:
      return {
        ...base,
        titlePrimary: "Local Mode",
        titleSecondary: "Connect account",
        showTitleDot: false,
        titleDot: "off",
        userSubtitle: "Local workspace",
        indicators: [
          engineIndicator(facts),
          { label: "ORVYN Cloud Offline", tone: "off" },
        ],
        modeLabel: "Local",
        menuStatus: "Local mode",
        signedIn: false,
      };
  }
}

export interface HeroMission {
  tone: string;
}

/** Home hero subtitle. Cloud wording never claims "need a connection" once signed in and online. */
export function heroStatusLine(facts: ConnectionFacts, missions: HeroMission[]): string {
  const state = deriveCloudConnectionState(facts);
  const workers = Math.max(0, facts.workerOnlineCount);
  const workerPhrase = (n: number, tail: "online" | "available") =>
    `${n} worker${n === 1 ? "" : "s"} ${tail}`;

  if (state === "cloud-online" || state === "cloud-synced") {
    const pending = missions.filter((m) => m.tone !== "done");
    if (pending.length === 0) {
      return `ORVYN Cloud connected · ${workerPhrase(workers, "available")}`;
    }
    const n = pending.length;
    return `${n} mission${n === 1 ? "" : "s"} ready · ${workerPhrase(workers, "online")}`;
  }

  if (state === "connecting") return "Connecting to ORVYN Cloud…";

  if (missions.length > 0) {
    const n = missions.length;
    const be = n === 1 ? "is" : "are";
    const need = n === 1 ? "needs" : "need";
    return `${n} mission${n === 1 ? "" : "s"} ${be} waiting on you — ${n} ${need} a connection.`;
  }

  return "Nothing needs you right now. What should we work on?";
}
