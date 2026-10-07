// apps/backend/src/services/UsageService.ts
//
// Usage metering at the provider boundary. Every registered model is wrapped
// in a metering proxy, so every generate/stream/image call — from chat, the
// composer, inline edit, or any agent runtime — produces a usage event no
// matter which code path made it. Billing must come from these server-side
// records, never from provider dashboards.
//
// Honesty rules:
//   - Provider-reported token counts are preferred. Missing counts are explicitly
//     marked as estimated; trusted settled cost takes precedence for billing.
//   - Mission/task/agent attribution comes from AsyncLocalStorage context set
//     by the runtimes; requests outside a mission simply have no missionId.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AIChunk, AIModelProvider, AIRequest, AIResponse, type ModelConfig } from "@orvyn/ai-core";
import { isTransientError, withModelRetries } from "./modelRetries";

export interface UsageContext {
  missionId?: string;
  taskId?: string;
  agent?: string;
  /** Non-mission callers label themselves: "chat", "composer", "inline-edit", … */
  source?: string;
}

export interface UsageEvent {
  imageRate?: ModelConfig["imageRate"];
  imageCount?: number;
  providerCostUsd?: number;
  imagePremium?: boolean;
  rate?: ModelConfig["rate"];
  cachedTokens?: number;
  id: string;
  timestamp: number;
  modelId: string;
  provider: string;
  method: "generate" | "stream" | "image" | "embed";
  durationMs: number;
  ok: boolean;
  error?: string;
  /** Only present when the provider reported real token counts. */
  promptTokens?: number;
  completionTokens?: number;
  /** Stream/generate output size — always measurable, never estimated tokens. */
  outputChars?: number;
  /** True when the provider reported no token counts and they were estimated from the text (billing never treats "unknown" as free). */
  estimated?: boolean;
  toolCalls?: number;
  missionId?: string;
  taskId?: string;
  agent?: string;
  source?: string;
}

const MAX_EVENTS = 5000;

/** Thrown before a model call when the tenant's monthly budget is spent. */
export class QuotaExceededError extends Error {
  readonly statusCode = 429;
  constructor(used: number, limit: number) {
    super(
      `Monthly model-request quota exceeded (${used}/${limit}). ` +
        `The quota resets at the start of next month (UTC). ` +
        `Raise ORVYN_QUOTA_MODEL_REQUESTS_MONTH or upgrade the plan.`
    );
  }
}

/**
 * Thrown when a single mission blows past its runaway-guard budget (spec §45).
 * Unlike the monthly quota this is not billing — it exists so a stuck agent
 * loop cannot bill indefinitely while nobody is watching.
 */
export class MissionBudgetExceededError extends Error {
  constructor(what: string, used: number, limit: number) {
    super(`Mission budget exceeded — ${what}: ${used}/${limit}. Set ORVYN_MISSION_MAX_${what === "model requests" ? "MODEL_REQUESTS" : "TOKENS"} higher (0 disables) or start a new mission.`);
  }
}

interface MissionCounters {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

function utcMonthStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

interface UsageStore {
  saveUsageEvent(e: UsageEvent): void | Promise<void>;
  loadRecentUsage(limit?: number): UsageEvent[] | Promise<UsageEvent[]>;
  countUsageSince?(ts: number): number | Promise<number>;
}
type UsageRelease = () => void | Promise<void>;
// Existing synchronous listeners may return incidental values; await thenables and ignore results.
type UsageSink = (event: UsageEvent) => unknown;
type UsageGuard = (ctx: UsageContext, model?: UsagePreflight) => void | UsageRelease | Promise<void | UsageRelease>;

class UsagePersistenceError extends Error {
  constructor() { super("Usage storage is temporarily unavailable. Please retry."); }
}

export class UsageService {
  private storeReady: Promise<void> = Promise.resolve();
  private pendingStorage: UsageEvent[] = [];
  private storing?: Promise<void>;
  private events: UsageEvent[] = [];
  private als = new AsyncLocalStorage<UsageContext>();
  private store?: UsageStore;
  private sinks: UsageSink[] = [];
  private pendingSinks: Array<{ event: UsageEvent; sink: UsageSink }> = [];
  private preflights: UsageGuard[] = [];
  private settling = new Set<Promise<void>>();
  private retrying?: Promise<void>;

  // Monthly quota on model requests. 0 = unlimited (the local-mode default).
  // Enforced in wrap() BEFORE the provider call — the one choke point every
  // code path (chat, composer, agents, missions) already goes through.
  private quotaLimit = Number(process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH) || 0;
  private monthStart = utcMonthStart();
  private monthCount = 0;

  // Per-mission runaway guards (spec §45). 0 disables either one. Read from
  // env on each check so tests and ops can change them without a restart.
  private missions = new Map<string, MissionCounters>();
  private missionMaxRequests(): number {
    return Number(process.env.ORVYN_MISSION_MAX_MODEL_REQUESTS) ?? 0;
  }
  private missionMaxTokens(): number {
    return Number(process.env.ORVYN_MISSION_MAX_TOKENS) ?? 0;
  }

  /**
   * Attach durable storage: hydrates the in-memory window from disk and
   * persists every subsequent event. Structural type avoids a circular import
   * with LocalStore.
   */
  /** A check run before every provider call (the credit wallet): throwing stops the call. */
  onPreflight(fn: UsageGuard): void {
    this.preflights.push(fn);
  }

  private async retryPendingSinks(): Promise<void> {
    if (!this.retrying) this.retrying = (async () => {
      while (this.pendingSinks.length) {
        const pending = this.pendingSinks[0];
        try { await pending.sink(pending.event); } catch { throw new Error("Billing settlement is temporarily unavailable. Please retry."); }
        this.pendingSinks.shift();
      }
    })().finally(() => { this.retrying = undefined; });
    return this.retrying;
  }

  private async runPreflight(model?: UsagePreflight): Promise<() => Promise<void>> {
    await this.storeReady;
    await this.flushStorage();
    await Promise.all([...this.settling]);
    await this.retryPendingSinks();
    const ctx = this.als.getStore() ?? {};
    const releases: UsageRelease[] = [];
    const releaseAll = async () => {
      let failure: unknown;
      let failed = false;
      for (const release of [...releases].reverse()) {
        try { await release(); } catch (error) { if (!failed) failure = error; failed = true; }
      }
      if (failed) throw failure;
    };
    try {
      for (const fn of this.preflights) { const release = await fn(ctx, model); if (release) releases.push(release); }
    } catch (err) { try { await releaseAll(); } catch { /* preserve the admission failure */ } throw err; }
    return releaseAll;
  }

  /** Covers adapters and the direct Fireworks Kontext wire with the same billing boundary. */
  async imageCall<T>(config: Pick<ModelConfig, "id" | "provider" | "providerName" | "rate" | "imageRate" | "imageSettlementBudgetUsd">, count: number,
    call: () => Promise<T>, produced: (result: T) => number, settledCost?: (result: T) => number | undefined): Promise<T> {
    await this.checkQuotaAsync();
    this.checkMissionBudget();
    const rate = config.imageRate ? { ...config.imageRate } : undefined;
    const release = await this.runPreflight({ id: config.id, method: "image", imageCount: count,
      imageRate: rate, rate: config.rate, imageSettlementBudgetUsd: config.imageSettlementBudgetUsd, providerCostUsd: config.imageSettlementBudgetUsd ? count * config.imageSettlementBudgetUsd : rate ? count * rate.usdPerImage : undefined });
    const start = Date.now();
    try {
      const result = await call();
      const actual = produced(result);
      if (!Number.isInteger(actual) || actual < 1 || actual > count) throw new Error("Image provider returned an invalid image count");
      const exact = settledCost?.(result);
      if (config.imageSettlementBudgetUsd && (exact === undefined || !Number.isFinite(exact) || exact < 0)) throw new Error("Image provider did not report final settled cost");
      await this.record({ modelId: config.id, provider: config.providerName ?? config.provider, method: "image", ok: true,
        imageCount: actual, imageRate: rate, imagePremium: rate?.premium, providerCostUsd: exact ?? (rate ? actual * rate.usdPerImage : undefined), durationMs: Date.now() - start });
      return result;
    } catch (err: any) {
      if (err instanceof UsagePersistenceError) throw err;
      await this.record({ modelId: config.id, provider: config.providerName ?? config.provider, method: "image", ok: false,
        imageCount: 0, providerCostUsd: 0, durationMs: Date.now() - start, error: String(err?.message ?? err).slice(0, 300) });
      throw err;
    } finally { await release(); }
  }

  onRecord(fn: UsageSink): void {
    this.sinks.push(fn);
  }

  attachStore(store: UsageStore): void | Promise<void> {
    this.store = store;
    const persisted = store.loadRecentUsage(MAX_EVENTS);
    const count = store.countUsageSince?.(this.monthStart);
    const hydrate = (events: UsageEvent[], total?: number) => {
      const existing = new Set(this.events.map(event => event.id));
      this.events = [...events.filter(event => !existing.has(event.id)), ...this.events].slice(-MAX_EVENTS);
      if (total !== undefined) this.monthCount = total;
    };
    if (Array.isArray(persisted) && (count === undefined || typeof count === "number")) {
      hydrate(persisted, count);
      return;
    }
    this.storeReady = Promise.all([persisted, count]).then(([events, total]) => { hydrate(events, total); });
    void this.storeReady.catch(() => {});
    return this.storeReady;
  }

  /** Read authoritative usage before admission or displaying a quota. */
  async quotaAsync(): Promise<ReturnType<UsageService["quota"]>> {
    await this.storeReady;
    await this.flushStorage();
    this.rollMonth();
    if (this.store?.countUsageSince) this.monthCount = await this.store.countUsageSince(this.monthStart);
    return this.quota();
  }

  private async checkQuotaAsync(): Promise<void> {
    await this.quotaAsync();
    this.checkQuota();
  }

  private flushStorage(): Promise<void> {
    if (!this.storing) this.storing = (async () => {
      while (this.pendingStorage.length) {
        const event = this.pendingStorage[0];
        try { await this.store?.saveUsageEvent(event); }
        catch { throw new UsagePersistenceError(); }
        for (const sink of this.sinks) {
          try { await sink(event); } catch (err) {
            this.pendingSinks.push({ event, sink });
            console.warn(`Credit ledger did not accept usage ${event.id}: ${(err as Error).message}`);
          }
        }
        this.pendingStorage.shift();
      }
    })().finally(() => { this.storing = undefined; });
    return this.storing;
  }

  /** Current quota state; surfaced on /usage so clients can warn early. */
  quota(): { limit: number; used: number; remaining: number | null; resetsAt: number } {
    this.rollMonth();
    return {
      limit: this.quotaLimit,
      used: this.monthCount,
      remaining: this.quotaLimit > 0 ? Math.max(0, this.quotaLimit - this.monthCount) : null,
      resetsAt: utcMonthStart(new Date(this.monthStart).setUTCMonth(new Date(this.monthStart).getUTCMonth() + 1)),
    };
  }

  private rollMonth(): void {
    const start = utcMonthStart();
    if (start !== this.monthStart) {
      this.monthStart = start;
      this.monthCount = 0;
    }
  }

  /** Throws QuotaExceededError when the monthly budget is spent. */
  checkQuota(): void {
    if (this.quotaLimit <= 0) return;
    this.rollMonth();
    if (this.monthCount >= this.quotaLimit) {
      throw new QuotaExceededError(this.monthCount, this.quotaLimit);
    }
  }

  /** Run `fn` with mission/task/agent attribution attached to every model call inside it. */
  with<T>(ctx: UsageContext, fn: () => Promise<T>): Promise<T> {
    // Merge with any outer context so a task-level wrap inherits the missionId.
    const merged = { ...this.als.getStore(), ...ctx };
    return this.als.run(merged, fn);
  }

  async record(e: Omit<UsageEvent, "id" | "timestamp" | keyof UsageContext>): Promise<void> {
    await this.storeReady;
    const ctx = this.als.getStore() ?? {};
    const event: UsageEvent = { id: `use_${randomUUID()}`, timestamp: Date.now(), ...ctx, ...e };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.rollMonth();
    this.monthCount++;
    this.pendingStorage.push(event);
    if (ctx.missionId) {
      const m = this.missions.get(ctx.missionId) ?? { requests: 0, promptTokens: 0, completionTokens: 0 };
      m.requests++;
      m.promptTokens += e.promptTokens ?? 0;
      m.completionTokens += e.completionTokens ?? 0;
      this.missions.set(ctx.missionId, m);
    }
    const settlement = this.flushStorage();
    this.settling.add(settlement);
    try { await settlement; } finally { this.settling.delete(settlement); }
  }

  /** Per-mission counters, for the usage endpoint and reports. */
  missionCounters(missionId: string): MissionCounters {
    return { ...(this.missions.get(missionId) ?? { requests: 0, promptTokens: 0, completionTokens: 0 }) };
  }

  /** A mission's budget is done: free its counters. */
  forgetMission(missionId: string): void {
    this.missions.delete(missionId);
  }

  /**
   * Throws MissionBudgetExceededError when the current mission (from the
   * AsyncLocalStorage context) is past its runaway-guard budget. Called in
   * wrap() before every provider call.
   */
  private checkMissionBudget(): void {
    const ctx = this.als.getStore();
    if (!ctx?.missionId) return;
    const m = this.missions.get(ctx.missionId);
    if (!m) return;

    const maxRequests = this.missionMaxRequests();
    if (maxRequests > 0 && m.requests >= maxRequests) {
      throw new MissionBudgetExceededError("model requests", m.requests, maxRequests);
    }
    const maxTokens = this.missionMaxTokens();
    if (maxTokens > 0 && m.promptTokens + m.completionTokens >= maxTokens) {
      throw new MissionBudgetExceededError("tokens", m.promptTokens + m.completionTokens, maxTokens);
    }
  }

  recent(limit = 200): UsageEvent[] {
    return this.events.slice(-limit).reverse();
  }

  totals() {
    const byModel = new Map<string, { requests: number; errors: number; promptTokens: number; completionTokens: number; durationMs: number }>();
    const byMission = new Map<string, { requests: number; promptTokens: number; completionTokens: number }>();
    let requests = 0, errors = 0, promptTokens = 0, completionTokens = 0, tokensReportedFor = 0;

    for (const e of this.events) {
      requests++;
      if (!e.ok) errors++;
      const m = byModel.get(e.modelId) ?? { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, durationMs: 0 };
      m.requests++;
      if (!e.ok) m.errors++;
      m.durationMs += e.durationMs;
      if (typeof e.promptTokens === "number") {
        tokensReportedFor++;
        promptTokens += e.promptTokens;
        completionTokens += e.completionTokens ?? 0;
        m.promptTokens += e.promptTokens;
        m.completionTokens += e.completionTokens ?? 0;
      }
      byModel.set(e.modelId, m);

      if (e.missionId) {
        const mm = byMission.get(e.missionId) ?? { requests: 0, promptTokens: 0, completionTokens: 0 };
        mm.requests++;
        mm.promptTokens += e.promptTokens ?? 0;
        mm.completionTokens += e.completionTokens ?? 0;
        byMission.set(e.missionId, mm);
      }
    }

    return {
      requests,
      errors,
      promptTokens,
      completionTokens,
      /** How many events actually carried provider-reported token counts. */
      tokensReportedFor,
      byModel: Object.fromEntries(byModel),
      byMission: Object.fromEntries(byMission),
    };
  }

  /** Wrap a provider so every inference call is metered. Delegates everything else. */
  wrap(inner: AIModelProvider): AIModelProvider {
    const usage = this;

    const wrapper: AIModelProvider = {
      get config() {
        return inner.config;
      },

      async generate(request: AIRequest): Promise<AIResponse> {
        const rate = inner.config.rate ? { ...inner.config.rate } : undefined;
        await usage.checkQuotaAsync();
        usage.checkMissionBudget();
        const release = await usage.runPreflight({ ...inner.config, rate });
        const start = Date.now();
        try {
          // Retry lives INSIDE the metered boundary: one usage event records
          // the final outcome, not one per attempt.
          const res = await withModelRetries(() => inner.generate(request), {
            label: `${inner.config.id} generate`,
            signal: request.signal,
          });
          const reported = Boolean(res.usage);
          if (inner.config.billingRequired && inner.config.settledCostRequired && res.usage?.providerCostUsd === undefined) throw new Error("Provider did not report final settled cost");
          await usage.record({
            rate,
            cachedTokens: res.usage?.cachedTokens,
            providerCostUsd: res.usage?.providerCostUsd,
            modelId: inner.config.id,
            provider: inner.config.providerName ?? inner.config.provider,
            method: "generate",
            durationMs: Date.now() - start,
            ok: true,
            promptTokens: reported ? res.usage?.promptTokens : estimateTokens(requestChars(request)),
            completionTokens: reported ? res.usage?.completionTokens : estimateTokens((res.content?.length ?? 0) + JSON.stringify(res.toolCalls ?? []).length),
            estimated: reported ? undefined : true,
            outputChars: res.content?.length ?? 0,
            toolCalls: res.toolCalls?.length || undefined,
          });
          return res;
        } catch (err: any) {
          if (err instanceof UsagePersistenceError) throw err;
          await usage.record({
            modelId: inner.config.id,
            provider: inner.config.providerName ?? inner.config.provider,
            method: "generate",
            durationMs: Date.now() - start,
            ok: false,
            error: String(err?.message ?? err).slice(0, 300),
          });
          throw err;
        } finally { await release(); }
      },

      async *stream(request: AIRequest): AsyncIterable<AIChunk> {
        const rate = inner.config.rate ? { ...inner.config.rate } : undefined;
        await usage.checkQuotaAsync();
        usage.checkMissionBudget();
        const release = await usage.runPreflight({ ...inner.config, rate });
        const start = Date.now();
        let chars = 0;
        let toolCalls = 0;
        let reportedUsage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; providerCostUsd?: number } | undefined;
        let settled = false;
        let yieldedAny = false;
        const recordOk = async () => {
          if (settled) return;
          if (inner.config.billingRequired && inner.config.settledCostRequired && reportedUsage?.providerCostUsd === undefined) throw new Error("Provider did not report final settled cost");
          settled = true;
          await usage.record({
            modelId: inner.config.id,
            provider: inner.config.providerName ?? inner.config.provider,
            method: "stream",
            durationMs: Date.now() - start,
            ok: true,
            rate,
            cachedTokens: reportedUsage?.cachedTokens,
            providerCostUsd: reportedUsage?.providerCostUsd,
            promptTokens: reportedUsage?.promptTokens ?? estimateTokens(requestChars(request)),
            completionTokens: reportedUsage?.completionTokens ?? estimateTokens(chars),
            estimated: reportedUsage ? undefined : true,
            outputChars: chars,
            toolCalls: toolCalls || undefined,
          });
        };
        try {
          // A stream may only be retried before the first chunk reaches the
          // consumer — after that, replaying would duplicate output. One quick
          // retry covers a hiccup; a provider that keeps failing is handed to
          // the caller, which fails over (same model on another provider,
          // then an equivalent model) instead of waiting here forever.
          let yielded = false;
          const maxAttempts = Math.max(1, Number(process.env.ORVYN_STREAM_RETRY_ATTEMPTS) || 2);
          for (let attempt = 1; ; attempt++) {
            try {
              for await (const chunk of inner.stream(request)) {
                yielded = true;
                yieldedAny = true;
                chars += chunk.delta?.length ?? 0;
                if (chunk.toolCall) { toolCalls++; chars += JSON.stringify(chunk.toolCall).length; }
                if (chunk.usage) reportedUsage = chunk.usage;
                yield chunk;
              }
              break;
            } catch (err: any) {
              if (yielded || !isTransientError(err) || request.signal?.aborted || attempt >= maxAttempts) throw err;
              console.warn(
                `[model-retry] ${inner.config.id} stream failed before any output ` +
                  `(${String(err?.message ?? err).slice(0, 140)}); retrying`
              );
              await new Promise((r) => setTimeout(r, 800));
            }
          }
          await recordOk();
        } catch (err: any) {
          settled = true;
          if (err instanceof UsagePersistenceError) throw err;
          await usage.record({
            modelId: inner.config.id,
            provider: inner.config.providerName ?? inner.config.provider,
            method: "stream",
            durationMs: Date.now() - start,
            ok: false,
            outputChars: chars,
            error: String(err?.message ?? err).slice(0, 300),
          });
          throw err;
        } finally {
          // The consumer stopped reading (it had the final chunk, or the run
          // was cancelled mid-answer): what was delivered is still one call.
          try { if (!settled && yieldedAny) await recordOk(); }
          finally { await release(); }
        }
      },

      healthCheck: () => inner.healthCheck(),
      supportsTools: () => inner.supportsTools(),
      supportsVision: () => inner.supportsVision(),
    };

    // Optional capabilities: only present on the wrapper when the inner
    // adapter has them, because callers feature-detect with `provider.embed?`.
    const embed = async (inputs: string[]): Promise<number[][]> => {
      if (!inputs.length) return [];
      const rate = inner.config.rate ? { ...inner.config.rate } : undefined;
      await usage.checkQuotaAsync(); usage.checkMissionBudget(); const release = await usage.runPreflight({ ...inner.config, rate });
      const start = Date.now();
      try {
        const result = inner.embedWithUsage ? await inner.embedWithUsage(inputs) : { embeddings: inner.embedMany ? await inner.embedMany(inputs) : await Promise.all(inputs.map((s) => inner.embed!(s))) };
        await usage.record({ modelId: inner.config.id, provider: inner.config.providerName ?? inner.config.provider, method: "embed", ok: true, rate, durationMs: Date.now() - start,
          promptTokens: result.usage?.promptTokens ?? estimateTokens(inputs.reduce((sum, s) => sum + s.length, 0)), completionTokens: 0,
          cachedTokens: result.usage?.cachedTokens, providerCostUsd: result.usage?.providerCostUsd, estimated: result.usage ? undefined : true });
        return result.embeddings;
      } catch (err: any) {
        if (err instanceof UsagePersistenceError) throw err;
        await usage.record({ modelId: inner.config.id, provider: inner.config.providerName ?? inner.config.provider, method: "embed", ok: false, durationMs: Date.now() - start, error: String(err?.message ?? err).slice(0, 300) });
        throw err;
      } finally { await release(); }
    };
    if (inner.embed) wrapper.embed = async (input) => (await embed([input]))[0] ?? [];
    if (inner.embedMany) wrapper.embedMany = embed;
    if (inner.generateImage) {
      wrapper.generateImage = async (request) => {
        return usage.imageCall(inner.config, request.n ?? 1, () => inner.generateImage!(request), (res) => res.length, (res) => res.usage?.providerCostUsd);
      };
    }

    return wrapper;
  }
}

export interface UsagePreflight {
  id: string;
  provider?: string;
  providerName?: string;
  rate?: ModelConfig["rate"];
  method?: "image";
  imageCount?: number;
  imageRate?: ModelConfig["imageRate"];
  imageSettlementBudgetUsd?: number;
  providerCostUsd?: number;
}

/** ~4 characters per token: a conservative estimate used only when the provider reports nothing. */
export function estimateTokens(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function requestChars(request: unknown): number {
  try {
    const r = request as { messages?: unknown; tools?: unknown; system?: unknown };
    return JSON.stringify([r.system ?? "", r.messages ?? [], r.tools ?? []]).length;
  } catch {
    return 0;
  }
}
