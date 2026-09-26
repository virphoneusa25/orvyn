export type PlanId = "starter" | "pro" | "team" | "enterprise";
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
  monthlyCredits: number;
  rolling5h: number;
  rolling7d: number;
  burst5h: number;
  concurrentRuns: number;
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
}

export const PLANS: Record<PlanId, PlanDef> = {
  starter: {
    id: "starter", label: "Starter", priceLabel: "$19/mo",
    monthlyCredits: 4_000, rolling5h: 800, rolling7d: 1_800, burst5h: 1_200,
    concurrentRuns: 1, perRunCostUsd: 0.5, cloudWorkers: 1, desktopSessions: 1, browserSessions: 2,
    images5h: 20, images7d: 50, proImages5h: 5, proImages7d: 15, ultraPer7d: 0, deepPer7d: 2, pooling: false,
  },
  pro: {
    id: "pro", label: "Pro", priceLabel: "$39/mo",
    monthlyCredits: 10_000, rolling5h: 2_500, rolling7d: 5_000, burst5h: 4_000,
    concurrentRuns: 2, perRunCostUsd: 1.5, cloudWorkers: 2, desktopSessions: 2, browserSessions: 5,
    images5h: 75, images7d: 250, proImages5h: 25, proImages7d: 80, ultraPer7d: 4, deepPer7d: 40, pooling: false,
  },
  team: {
    id: "team", label: "Team", priceLabel: "$69/user/mo",
    monthlyCredits: 18_000, rolling5h: 5_000, rolling7d: 9_000, burst5h: 8_000,
    concurrentRuns: 4, perRunCostUsd: 3, cloudWorkers: 4, desktopSessions: 2, browserSessions: 10,
    images5h: 150, images7d: 500, proImages5h: 50, proImages7d: 160, ultraPer7d: 20, deepPer7d: 200, pooling: true,
  },
  enterprise: {
    id: "enterprise", label: "Enterprise", priceLabel: "Custom",
    monthlyCredits: 18_000, rolling5h: 5_000, rolling7d: 9_000, burst5h: 8_000,
    concurrentRuns: 8, perRunCostUsd: 10, cloudWorkers: 8, desktopSessions: 4, browserSessions: 20,
    images5h: 400, images7d: 1_500, proImages5h: 100, proImages7d: 400, ultraPer7d: 100, deepPer7d: 1_000, pooling: true,
  },
};

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
  { id: "pack_5k", credits: 5_000, priceUsd: 15 },
  { id: "pack_15k", credits: 15_000, priceUsd: 39 },
  { id: "pack_40k", credits: 40_000, priceUsd: 99 },
  { id: "pack_100k", credits: 100_000, priceUsd: 229 },
] as const;

export type PackId = (typeof CREDIT_PACKS)[number]["id"];

export function planById(id: string): PlanDef {
  if (id in PLANS) return PLANS[id as PlanId];
  return PLANS.starter;
}

export function laneForUsage(event: { method?: string; source?: string; agent?: string }): Lane {
  if (event.method === "image") return "image";
  const blob = `${event.source ?? ""} ${event.agent ?? ""}`.toLowerCase();
  if (/ssh|server/.test(blob)) return "server";
  if (/code|composer|build/.test(blob)) return "build";
  if (/research|search/.test(blob)) return "search";
  return "auto";
}

export function packById(id: string) {
  return CREDIT_PACKS.find((p) => p.id === id) ?? null;
}
