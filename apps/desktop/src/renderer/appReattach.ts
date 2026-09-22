// apps/desktop/src/renderer/appReattach.ts
//
// Restart reattachment decision, extracted so it is unit-testable: given the
// runs visible to the current backend, pick the one an app launch should
// reattach to — the NEWEST run that is still in flight. A terminal run is
// never reattached (nothing to resume); an empty list reattaches nothing.

export interface ReattachRunInfo {
  id: string;
  status: string;
  createdAt: number;
}

const IN_FLIGHT = new Set(["running", "queued", "awaiting_approval"]);

/** Newest in-flight run id, or null when there is nothing to reattach. */
export function pickReattachRun(runs: ReattachRunInfo[]): string | null {
  let newest: ReattachRunInfo | null = null;
  for (const run of runs) {
    if (!IN_FLIGHT.has(run.status)) continue;
    if (!newest || Number(run.createdAt) > Number(newest.createdAt)) newest = run;
  }
  return newest?.id ?? null;
}
