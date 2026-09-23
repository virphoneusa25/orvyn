import net from "net";

export function redisPrefix(): string {
  return (process.env.ORVYN_REDIS_PREFIX?.trim() || `orvyn:${process.env.ORVYN_ENV?.trim() || "local"}:`) + "";
}

export async function redisHealth(url = process.env.ORVYN_REDIS_URL): Promise<{ healthy: boolean; detail?: string }> {
  if (!url) return { healthy: true, detail: "not configured (local mode)" };
  try {
    const parsed = new URL(url);
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect(Number(parsed.port || 6379), parsed.hostname);
      sock.setTimeout(2000);
      sock.on("connect", () => {
        sock.write("PING\r\n");
      });
      sock.on("data", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => {
        sock.destroy();
        resolve(false);
      });
    });
    return ok
      ? { healthy: true, detail: `namespace ${redisPrefix()}` }
      : { healthy: false, detail: "connection refused" };
  } catch (err: any) {
    return { healthy: false, detail: err?.message ?? "redis error" };
  }
}
