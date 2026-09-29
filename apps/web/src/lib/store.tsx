import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, getToken, onUnauthorized, setToken } from "./api";

// The signed-in account, its wallet and its ORVYN models: shared by every page.

export interface Me {
  user: { id: string; email: string; name: string | null; emailVerified?: boolean };
  principal: { organizationName: string; organizationKind: string; role: string; tenantId: string };
  organizations: { id: string; name: string; kind: string }[];
  onboarding: { step: string; completedAt: number | null } | null;
  verificationRequired?: boolean;
}

export interface Window { used: number; limit: number; resetAt: number }
export interface Wallet {
  plan: { id: string; label: string; priceLabel: string };
  subscription?: { status: string; cycleStart: number; cycleEnd: number };
  includedBalance: number; purchasedBalance: number; reservedBalance: number; availableBalance: number;
  windows: { fiveHour: Window; sevenDay: Window; cycle: Window };
  autoRecharge?: { threshold: number; pack_id: string; max_per_month: number; recharges_this_cycle: number } | null;
}
export interface Billing {
  wallet: Wallet;
  payments?: { enabled: boolean; canManage: boolean; packs: { id: string; credits: number; priceUsd: number; available: boolean }[] };
}
export interface Model { id: string; name: string; description?: string; kind: "orvyn" | "user"; available?: boolean }

interface Store {
  me: Me | null;
  billing: Billing | null;
  models: Model[];
  model: string;
  setModel: (id: string) => void;
  status: "loading" | "signed-out" | "gated" | "ready";
  gate: string | null;
  refresh: () => Promise<void>;
  refreshBilling: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  toast: (msg: string) => void;
  toastMsg: string | null;
}

const Ctx = createContext<Store | null>(null);
export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("store outside provider");
  return s;
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModelState] = useState<string>(() => { try { return localStorage.getItem("orvyn.model") || "auto"; } catch { return "auto"; } });
  const [status, setStatus] = useState<Store["status"]>(getToken() ? "loading" : "signed-out");
  const [gate, setGate] = useState<string | null>(null);
  const [toastMsg, setToast] = useState<string | null>(null);

  const toast = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(null), 3200); }, []);
  const setModel = useCallback((id: string) => { setModelState(id); try { localStorage.setItem("orvyn.model", id); } catch { /* */ } }, []);

  const refreshBilling = useCallback(async () => {
    try { setBilling(await api<Billing>("/billing")); } catch { /* shown as unavailable */ }
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) { setStatus("signed-out"); return; }
    try {
      const m = await api<Me>("/auth/me");
      setMe(m);
      const verified = m.user.emailVerified !== false || m.verificationRequired === false;
      if (!verified) { setGate("EMAIL_NOT_VERIFIED"); setStatus("gated"); return; }
      if (!m.onboarding?.completedAt) { setGate("ONBOARDING_REQUIRED"); setStatus("gated"); return; }
      setGate(null);
      const [, mdl] = await Promise.all([refreshBilling(), api<{ models: Model[] }>("/models").catch(() => ({ models: [] }))]);
      setModels((mdl.models ?? []).filter((x) => x.kind === "orvyn" || x.kind === "user"));
      setStatus("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { setToken(null); setMe(null); setStatus("signed-out"); return; }
      if (err instanceof ApiError && (err.code === "EMAIL_NOT_VERIFIED" || err.code === "ONBOARDING_REQUIRED")) { setGate(err.code); setStatus("gated"); return; }
      setStatus("ready");
    }
  }, [refreshBilling]);

  const signIn = useCallback(async (token: string) => { setToken(token); setStatus("loading"); await refresh(); }, [refresh]);
  const signOut = useCallback(async () => {
    try { await api("/auth/logout", { method: "POST", body: {} }); } catch { /* already gone */ }
    setToken(null); setMe(null); setBilling(null); setStatus("signed-out");
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => onUnauthorized(() => { setToken(null); setMe(null); setStatus("signed-out"); }), []);
  // The balance moves as the account is used (here, on Desktop, or by a payment).
  useEffect(() => {
    if (status !== "ready") return;
    const t = window.setInterval(() => void refreshBilling(), 60_000);
    return () => window.clearInterval(t);
  }, [status, refreshBilling]);

  const value = useMemo<Store>(() => ({ me, billing, models, model, setModel, status, gate, refresh, refreshBilling, signIn, signOut, toast, toastMsg }), [me, billing, models, model, setModel, status, gate, refresh, refreshBilling, signIn, signOut, toast, toastMsg]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
