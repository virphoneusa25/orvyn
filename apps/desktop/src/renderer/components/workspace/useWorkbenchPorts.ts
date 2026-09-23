import { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../../connection";
import { detectPortsFromText, type PortClass } from "../../workbenchPorts";
import type { WorkbenchEnvironment } from "../../workbenchEnvironment";

export interface PublicPort {
  id: string;
  port: number;
  command?: string;
  environment: WorkbenchEnvironment;
  classification: PortClass;
  status: "listening" | "forwarded" | "inactive";
  previewUrl?: string;
  localUrl?: string;
}

const AUTO_KEY = "orvyn:ports-auto-forward";

export function useWorkbenchPorts(opts: {
  environment: WorkbenchEnvironment;
  runId?: string | null;
  projectRoot: string | null;
  eventText: string;
}) {
  const [ports, setPorts] = useState<PublicPort[]>([]);
  const [autoForward, setAutoForward] = useState(() => {
    try { return globalThis.localStorage?.getItem(AUTO_KEY) !== "false"; } catch { return true; }
  });

  function persistAuto(next: boolean) {
    setAutoForward(next);
    try { globalThis.localStorage?.setItem(AUTO_KEY, String(next)); } catch { /* ignore */ }
  }

  async function refresh(detected = detectPortsFromText(opts.eventText, opts.environment)) {
    try {
      const r = await fetch(apiUrl("/ports/detect"), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          environment: opts.environment,
          runId: opts.runId,
          workspace: opts.projectRoot,
          autoForward,
          ports: detected.map((p) => ({ port: p.port, command: p.command })),
        }),
      });
      const d = await r.json();
      if (Array.isArray(d.ports)) setPorts(d.ports);
    } catch {
      /* offline */
    }
  }

  useEffect(() => {
    void refresh();
  }, [opts.eventText, opts.environment, opts.runId, autoForward]);

  async function stop(id: string) {
    const r = await fetch(apiUrl(`/ports/${id}/stop`), { method: "POST", headers: authHeaders() });
    const d = await r.json().catch(() => ({}));
    if (d.port) setPorts((prev) => prev.map((p) => (p.id === id ? d.port : p)));
  }

  return { ports, autoForward, setAutoForward: persistAuto, refresh, stop };
}
