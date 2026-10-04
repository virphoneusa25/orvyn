export type PlanId = "free" | "starter" | "pro" | "power" | "business" | "team" | "enterprise";
export type Lane =
  | "utility"
  | "auto"
  | "build"
  | "server"
  | "advanced"
  | "deep"
  | "ultra"
  | "image"
  | "image_pro"
  | "search"
  | "compute";

export interface PlanDef {
  id: PlanId;
  label: string;
  priceLabel: string;
  /** List prices in USD (null: negotiated). Annual ≈ two months free. */
  priceMonthlyUsd: number | null;
  priceAnnualUsd: number | null;
  monthlyCredits: number;
  /** Rolling 5-hour and 7-day premium-compute allowances (credits). */
  rolling5h: number;
  rolling7d: number;
  burst5h: number;
  /** Parallel agents. */
  concurrentRuns: number;
  /** Active projects (null: unlimited). */
  projects: number | null;
  perRunCostUsd: number;
  cloudWorkers: number;
  desktopSessions: number;
  browserSessions: number;
  images5h: number;
  images7d: number;
  proImages5h: number;
  proImages7d: number;
  ultraPer7d: number;
  deepPer7d: number;
  pooling: boolean;
  /** What the plan unlocks (ORVYN Pricing & Billing Strategy, Sep 28 2026). */
  features: {
    premiumModels: "none" | "limited" | "full";
    ssh: "none" | "limited" | "full";
    deployments: "none" | "limited" | "full";
    apiAccess: boolean;
    teamSeats: number;
    priority: "standard" | "high" | "higher" | "highest";
  };
  /** Shown on the pricing page. */
  public: boolean;
}

// ORVYN Pricing, Credits, Limits & Hybrid AI Billing Strategy (FINAL, Sep 28 2026).
export const PLANS: Record<PlanId, PlanDef> = {
  free: {
    id: "free", label: "Free", priceLabel: "$0", priceMonthlyUsd: 0, priceAnnualUsd: null,
    monthlyCredits: 2_000, rolling5h: 500, rolling7d: 1_000, burst5h: 500,
    concurrentRuns: 1, projects: 1, perRunCostUsd: 0.25, cloudWorkers: 0, desktopSessions: 0, browserSessions: 1,
    images5h: 3, images7d: 10, proImages5h: 0, proImages7d: 0, ultraPer7d: 0, deepPer7d: 0, pooling: false,
    features: { premiumModels: "none", ssh: "none", deployments: "none", apiAccess: false, teamSeats: 0, priority: "standard" },
    public: true,
  },
  starter: {
    id: "starter", label: "Starter", priceLabel: "$29/mo", priceMonthlyUsd: 29, priceAnnualUsd: 290,
    monthlyCredits: 24_000, rolling5h: 6_000, rolling7d: 18_000, burst5h: 8_000,
    concurrentRuns: 1, projects: null, perRunCostUsd: 0.5, cloudWorkers: 1, desktopSessions: 1, browserSessions: 2,
    images5h: 20, images7d: 50, proImages5h: 5, proImages7d: 15, ultraPer7d: 0, deepPer7d: 2, pooling: false,
    features: { premiumModels: "none", ssh: "none", deployments: "none", apiAccess: false, teamSeats: 0, priority: "standard" },
    public: true,
  },
  pro: {
    id: "pro", label: "Pro", priceLabel: "$59/mo", priceMonthlyUsd: 59, priceAnnualUsd: 590,
    monthlyCredits: 60_000, rolling5h: 15_000, rolling7d: 45_000, burst5h: 20_000,
    concurrentRuns: 2, projects: null, perRunCostUsd: 1.5, cloudWorkers: 2, desktopSessions: 2, browserSessions: 5,
    images5h: 75, images7d: 250, proImages5h: 25, proImages7d: 80, ultraPer7d: 4, deepPer7d: 40, pooling: false,
    features: { premiumModels: "limited", ssh: "limited", deployments: "none", apiAccess: false, teamSeats: 0, priority: "standard" },
    public: true,
  },
  power: {
    id: "power", label: "Power", priceLabel: "$99/mo", priceMonthlyUsd: 99, priceAnnualUsd: 990,
    monthlyCredits: 120_000, rolling5h: 30_000, rolling7d: 90_000, burst5h: 40_000,
    concurrentRuns: 4, projects: null, perRunCostUsd: 3, cloudWorkers: 4, desktopSessions: 2, browserSessions: 8,
    images5h: 120, images7d: 400, proImages5h: 40, proImages7d: 130, ultraPer7d: 10, deepPer7d: 100, pooling: false,
    features: { premiumModels: "full", ssh: "full", deployments: "limited", apiAccess: false, teamSeats: 0, priority: "high" },
    public: true,
  },
  business: {
    id: "business", label: "Business", priceLabel: "$199/mo", priceMonthlyUsd: 199, priceAnnualUsd: 1_990,
    monthlyCredits: 240_000, rolling5h: 60_000, rolling7d: 180_000, burst5h: 80_000,
    concurrentRuns: 8, projects: null, perRunCostUsd: 6, cloudWorkers: 6, desktopSessions: 3, browserSessions: 12,
    images5h: 200, images7d: 700, proImages5h: 70, proImages7d: 240, ultraPer7d: 30, deepPer7d: 300, pooling: true,
    features: { premiumModels: "full", ssh: "full", deployments: "full", apiAccess: true, teamSeats: 3, priority: "higher" },
    public: true,
  },
  team: {
    id: "team", label: "Team", priceLabel: "$399/mo", priceMonthlyUsd: 399, priceAnnualUsd: 3_990,
    monthlyCredits: 500_000, rolling5h: 120_000, rolling7d: 375_000, burst5h: 160_000,
    concurrentRuns: 12, projects: null, perRunCostUsd: 10, cloudWorkers: 8, desktopSessions: 5, browserSessions: 20,
    images5h: 400, images7d: 1_500, proImages5h: 100, proImages7d: 400, ultraPer7d: 60, deepPer7d: 600, pooling: true,
    features: { premiumModels: "full", ssh: "full", deployments: "full", apiAccess: true, teamSeats: 5, priority: "highest" },
    public: true,
  },
  enterprise: {
    id: "enterprise", label: "Enterprise", priceLabel: "Custom", priceMonthlyUsd: null, priceAnnualUsd: null,
    monthlyCredits: 500_000, rolling5h: 120_000, rolling7d: 375_000, burst5h: 160_000,
    concurrentRuns: 16, projects: null, perRunCostUsd: 20, cloudWorkers: 16, desktopSessions: 8, browserSessions: 40,
    images5h: 800, images7d: 3_000, proImages5h: 200, proImages7d: 800, ultraPer7d: 200, deepPer7d: 2_000, pooling: true,
    features: { premiumModels: "full", ssh: "full", deployments: "full", apiAccess: true, teamSeats: 50, priority: "highest" },
    public: false,
  },
};

/** Plan every new account starts on. */
export const DEFAULT_PLAN: PlanId = "free";

/** Customer-facing lane multipliers. Provider dollars stay on the rate card. */
export const LANE_FACTORS: Record<Lane, number> = {
  utility: 1.75,
  auto: 2.25,
  build: 2.75,
  server: 2.75,
  advanced: 2.75,
  deep: 2.75,
  ultra: 3,
  image: 3,
  image_pro: 3.25,
  search: 2.5,
  compute: 2.5,
};

export const CREDIT_PACKS = [
  { id: "pack_10k", credits: 10_000, priceUsd: 10 },
  { id: "pack_25k", credits: 25_000, priceUsd: 24 },
  { id: "pack_50k", credits: 50_000, priceUsd: 45 },
  { id: "pack_100k", credits: 100_000, priceUsd: 85 },
  { id: "pack_250k", credits: 250_000, priceUsd: 195 },
  { id: "pack_500k", credits: 500_000, priceUsd: 365 },
] as const;

export type PackId = (typeof CREDIT_PACKS)[number]["id"];

export function planById(id: string): PlanDef {
  if (id in PLANS) return PLANS[id as PlanId];
  return PLANS[DEFAULT_PLAN];
}

export function laneForUsage(event: { method?: string; source?: string; agent?: string; imagePremium?: boolean; modelId?: string }): Lane {
  if (event.method === "image") return event.imagePremium || /flux-kontext-max$/.test(event.modelId ?? "") ? "image_pro" : "image";
  const blob = `${event.source ?? ""} ${event.agent ?? ""}`.toLowerCase();
  if (/ssh|server/.test(blob)) return "server";
  if (/code|composer|build/.test(blob)) return "build";
  if (/research|search/.test(blob)) return "search";
  return "auto";
}

export function packById(id: string) {
  return CREDIT_PACKS.find((p) => p.id === id) ?? null;
}
