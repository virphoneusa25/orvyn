import * as os from "os";
import { promises as fs } from "fs";

export const HOST_METRICS_SOURCE = "this-pc" as const;

export interface HostSystemStats {
  cpuPercent: number | null;
  ramPercent: number | null;
  diskPercent: number | null;
  source: typeof HOST_METRICS_SOURCE;
  sourceLabel: string;
}

export function hostMetricsSourceLabel(): string {
  return `This PC (${os.hostname()})`;
}

export function ramPercentFrom(total: number, free: number): number | null {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return null;
  return Math.min(100, Math.max(0, Math.round((1 - free / total) * 100)));
}

export function diskPercentFrom(blocks: number, bavail: number): number | null {
  if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(bavail)) return null;
  return Math.min(100, Math.max(0, Math.round((1 - bavail / blocks) * 100)));
}

export async function sampleHostStats(input?: {
  cpus?: os.CpuInfo[];
  totalmem?: number;
  freemem?: number;
  waitMs?: number;
}): Promise<HostSystemStats> {
  const sourceLabel = hostMetricsSourceLabel();
  try {
    const sample = (cpus: os.CpuInfo[]) => {
      let idle = 0;
      let total = 0;
      for (const c of cpus) {
        idle += c.times.idle;
        total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
      }
      return { idle, total };
    };
    const wait = input?.waitMs ?? 250;
    const a = sample(input?.cpus ?? os.cpus());
    await new Promise((r) => setTimeout(r, wait));
    const b = sample(os.cpus());
    const cpuPercent =
      b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100) : null;
    const ramPercent = ramPercentFrom(input?.totalmem ?? os.totalmem(), input?.freemem ?? os.freemem());
    let diskPercent: number | null = null;
    try {
      const statfs = (fs as unknown as {
        statfs?: (p: string) => Promise<{ bavail: number; blocks: number }>;
      }).statfs;
      if (statfs) {
        const st = await statfs(os.platform() === "win32" ? "C:\\" : "/");
        diskPercent = diskPercentFrom(st.blocks, st.bavail);
      }
    } catch {
      diskPercent = null;
    }
    return {
      cpuPercent: cpuPercent == null ? null : Math.min(100, Math.max(0, cpuPercent)),
      ramPercent,
      diskPercent,
      source: HOST_METRICS_SOURCE,
      sourceLabel,
    };
  } catch {
    return {
      cpuPercent: null,
      ramPercent: null,
      diskPercent: null,
      source: HOST_METRICS_SOURCE,
      sourceLabel,
    };
  }
}
