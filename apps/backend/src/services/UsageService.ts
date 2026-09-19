// apps/backend/src/services/UsageService.ts
//
// Usage metering at the provider boundary. Every registered model is wrapped
// in a metering proxy, so every generate/stream/image call — from chat, the
// composer, inline edit, or any agent runtime — produces a usage event no
// matter which code path made it. Billing must come from these server-side
// records, never from provider dashboards.
//
// Honesty rules:
//   - Token counts are recorded ONLY when the provider reports them
//     (AIResponse.usage). Streams don't report tokens on this wire; those
//     events carry duration + output size instead. Nothing is estimated.
//   - Mission/task/agent attribution comes from AsyncLocalStorage context set
//     by the runtimes; requests outside a mission simply have no missionId.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AIChunk, AIModelProvider, AIRequest, AIResponse } from "@orvyn/ai-core";
import { isTransientError, withModelRetries } from "./modelRetries";

export interface UsageContext {
  missionId?: string;
  taskId?: string;
  agent?: string;
  /** Non-mission callers label themselves: "chat", "composer", "inline-edit", … */
  source?: string;
}

export interface UsageEvent {
  id: string;
  timestamp: number;
  modelId: string;
  provider: string;
  method: "generate" | "stream" | "image";
  durationMs: number;
  ok: boolean;
  error?: string;
  /** Only present when the provider reported real token counts. */
  promptTokens?: number;
  completionTokens?: number;
  /** Stream/generate output size — always measurable, never estimated tokens. */
  outputChars?: number;
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
  saveUsageEvent(e: UsageEvent): void;
  loadRecentUsage(limit?: number): UsageEvent[];
  countUsageSince?(ts: number): number;
}

export class UsageService {
  private events: UsageEvent[] = [];
  private als = new AsyncLocalStorage<UsageContext>();
  private store?: UsageStore;

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
  attachStore(store: UsageStore): void {
    this.store = store;
    const persisted = store.loadRecentUsage(MAX_EVENTS);
    if (persisted.length > 0) {
      this.events = [...persisted, ...this.events].slice(-MAX_EVENTS);
    }
    // Quota counting must survive restarts, or a customer could reset their
    // budget by crashing the backend.
    this.monthCount = store.countUsageSince?.(this.monthStart) ?? this.monthCount;
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
      this.monthCount = this.store?.countUsageSince?.(start) ?? 0;
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

  record(e: Omit<UsageEvent, "id" | "timestamp" | keyof UsageContext>): void {
    const ctx = this.als.getStore() ?? {};
    const event: UsageEvent = { id: `use_${randomUUID().slice(0, 8)}`, timestamp: Date.now(), ...ctx, ...e };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.rollMonth();
    this.monthCount++;
    this.store?.saveUsageEvent(event);

    if (ctx.missionId) {
      const m = this.missions.get(ctx.missionId) ?? { requests: 0, promptTokens: 0, completionTokens: 0 };
      m.requests++;
      m.promptTokens += e.promptTokens ?? 0;
      m.completionTokens += e.completionTokens ?? 0;
      this.missions.set(ctx.missionId, m);
    }
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
        usage.checkQuota();
        usage.checkMissionBudget();
        const start = Date.now();
        try {
          // Retry lives INSIDE the metered boundary: one usage event records
          // the final outcome, not one per attempt.
          const res = await withModelRetries(() => inner.generate(request), {
            label: `${inner.config.id} generate`,
            signal: request.signal,
          });
          usage.record({
            modelId: inner.config.id,
            provider: inner.config.provider,
            method: "generate",
            durationMs: Date.now() - start,
            ok: true,
            promptTokens: res.usage?.promptTokens,
            completionTokens: res.usage?.completionTokens,
            outputChars: res.content?.length ?? 0,
            toolCalls: res.toolCalls?.length || undefined,
          });
          return res;
        } catch (err: any) {
          usage.record({
            modelId: inner.config.id,
            provider: inner.config.provider,
            method: "generate",
            durationMs: Date.now() - start,
            ok: false,
            error: String(err?.message ?? err).slice(0, 300),
          });
          throw err;
        }
      },

      async *stream(request: AIRequest): AsyncIterable<AIChunk> {
        usage.checkQuota();
        usage.checkMissionBudget();
        const start = Date.now();
        let chars = 0;
        let toolCalls = 0;
        try {
          // A stream may only be retried before the first chunk reaches the
          // consumer — after that, replaying would duplicate output.
          let yielded = false;
          while (true) {
            try {
              for await (const chunk of inner.stream(request)) {
                yielded = true;
                chars += chunk.delta?.length ?? 0;
                if (chunk.toolCall) toolCalls++;
                yield chunk;
              }
              break;
            } catch (err: any) {
              if (yielded || !isTransientError(err) || request.signal?.aborted) throw err;
              console.warn(
                `[model-retry] ${inner.config.id} stream failed before any output ` +
                  `(${String(err?.message ?? err).slice(0, 140)}); retrying`
              );
              await new Promise((r) => setTimeout(r, 800));
            }
          }
          usage.record({
            modelId: inner.config.id,
            provider: inner.config.provider,
            method: "stream",
            durationMs: Date.now() - start,
            ok: true,
            outputChars: chars,
            toolCalls: toolCalls || undefined,
          });
        } catch (err: any) {
          usage.record({
            modelId: inner.config.id,
            provider: inner.config.provider,
            method: "stream",
            durationMs: Date.now() - start,
            ok: false,
            outputChars: chars,
            error: String(err?.message ?? err).slice(0, 300),
          });
          throw err;
        }
      },

      healthCheck: () => inner.healthCheck(),
      supportsTools: () => inner.supportsTools(),
      supportsVision: () => inner.supportsVision(),
    };

    // Optional capabilities: only present on the wrapper when the inner
    // adapter has them, because callers feature-detect with `provider.embed?`.
    if (inner.embed) wrapper.embed = (input) => inner.embed!(input);
    if (inner.embedMany) wrapper.embedMany = (inputs) => inner.embedMany!(inputs);
    if (inner.generateImage) {
      wrapper.generateImage = async (request) => {
        usage.checkQuota();
        const start = Date.now();
        try {
          const res = await inner.generateImage!(request);
          usage.record({
            modelId: inner.config.id,
            provider: inner.config.provider,
            method: "image",
            durationMs: Date.now() - start,
            ok: true,
          });
          return res;
        } catch (err: any) {
          usage.record({
            modelId: inner.config.id,
            provider: inner.config.provider,
            method: "image",
            durationMs: Date.now() - start,
            ok: false,
            error: String(err?.message ?? err).slice(0, 300),
          });
          throw err;
        }
      };
    }

    return wrapper;
  }
}
