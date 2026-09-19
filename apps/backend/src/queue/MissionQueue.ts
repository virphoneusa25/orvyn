// apps/backend/src/queue/MissionQueue.ts
//
// Bounded mission concurrency per tenant. Missions are the most expensive
// thing the backend does (multi-agent loops, many model calls, shell/tool
// work) — without a bound, ten POST /agent/orchestrate calls run ten
// orchestrations at once and starve everything else on the box.
//
// This is the in-process driver: FIFO, per-tenant, survives nothing (a
// queued-but-unstarted mission dies with the process, and its run shows no
// completion — same as today's behavior on restart). The cloud tier replaces
// this class with a Redis-backed driver behind the same enqueue() call so
// missions can be distributed to worker containers; that driver lands when
// there is a Redis to run it against (see docs/CLOUD_ARCHITECTURE.md).
//
// ORVYN_MAX_CONCURRENT_MISSIONS: slots per tenant (default 2, min 1).

export type MissionJob = () => Promise<void>;

export class MissionQueue {
  public readonly concurrency: number;
  private running = 0;
  private waiting: MissionJob[] = [];

  constructor(concurrency?: number) {
    const fromEnv = Number(process.env.ORVYN_MAX_CONCURRENT_MISSIONS);
    this.concurrency = Math.max(1, concurrency ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 2));
  }

  stats(): { running: number; waiting: number; concurrency: number } {
    return { running: this.running, waiting: this.waiting.length, concurrency: this.concurrency };
  }

  /**
   * Enqueue a mission. Returns 0 when it starts immediately, otherwise its
   * 1-based position in the wait line.
   */
  enqueue(job: MissionJob): number {
    if (this.running < this.concurrency) {
      this.launch(job);
      return 0;
    }
    this.waiting.push(job);
    return this.waiting.length;
  }

  private launch(job: MissionJob): void {
    this.running++;
    // Errors are the job's own responsibility (orchestrate() already reports
    // failures through the run store); the queue only manages the slot.
    void job()
      .catch(() => {})
      .finally(() => {
        this.running--;
        const next = this.waiting.shift();
        if (next) this.launch(next);
      });
  }
}
