// apps/desktop/src/renderer/agentWorkspaceLayout.ts
//
// Single authority for Work Surface vs Inspector visibility.
// Title-bar toggle = Work Surface. Inspector is contextual.

import type { InspectorTab, SurfaceTab, WorkspaceActivity } from "./agentWorkspaceModel.ts";
import type { DesktopLayoutState } from "./desktopLayout.ts";

const CHAT_MIN = 500;
const INSPECTOR_MIN = 280;
const SIDEBAR_WIDTH = 222;

export type InspectorPlacement = "hidden" | "dock" | "overlay";

export function countRightColumns(state: Pick<DesktopLayoutState, "rightPanelOpen" | "inspectorOpen">): number {
  if (!state.rightPanelOpen) return 0;
  return state.inspectorOpen ? 2 : 1;
}

export function inspectorPlacement(
  viewportWidth: number,
  inspectorOpen: boolean,
  workSurfaceWidth: number
): InspectorPlacement {
  if (!inspectorOpen) return "hidden";
  const room = viewportWidth - SIDEBAR_WIDTH - CHAT_MIN - workSurfaceWidth - 8;
  return room >= INSPECTOR_MIN ? "dock" : "overlay";
}

export function isMeaningfulInspectorActivity(activity: WorkspaceActivity | null | undefined): boolean {
  if (!activity || activity.openInspector === false) return false;
  if (activity.inspector === "diff" && activity.priority >= 70) return true;
  if (activity.inspector === "review" && activity.openInspector === true) return true;
  if (activity.inspector === "terminal" && activity.priority >= 70) return true;
  return false;
}

export function inspectorOpenForRun(input: {
  runStatus: string;
  rightPanelOpen: boolean;
  inspectorPinned: boolean;
  inspectorOpen: boolean;
  explicitContext?: boolean;
}): boolean {
  if (!input.rightPanelOpen) return false;
  if (input.inspectorPinned || input.explicitContext) return true;
  if (/awaiting[_-]?approval/i.test(input.runStatus)) return false;
  return input.inspectorOpen;
}

export function surfacePrefersClosedInspector(surface: SurfaceTab | string | undefined): boolean {
  if (!surface) return false;
  return surface === "preview" || surface === "browser" || surface === "desktop" || String(surface).startsWith("preview:");
}

export interface InspectorDecision {
  inspectorOpen: boolean;
  inspectorTab?: InspectorTab;
  dismissed: boolean;
}

export function decideInspectorFollow(input: {
  pinned: boolean;
  inspectorOpen: boolean;
  dismissed: boolean;
  activity: WorkspaceActivity | null;
  surfaceId: string;
}): InspectorDecision {
  if (input.pinned) {
    return {
      inspectorOpen: true,
      inspectorTab: input.activity?.inspector,
      dismissed: false,
    };
  }
  if (surfacePrefersClosedInspector(input.surfaceId) && !isMeaningfulInspectorActivity(input.activity)) {
    return { inspectorOpen: false, dismissed: input.dismissed };
  }
  if (input.dismissed && !isMeaningfulInspectorActivity(input.activity)) {
    return { inspectorOpen: false, dismissed: true };
  }
  if (isMeaningfulInspectorActivity(input.activity) && input.activity) {
    return { inspectorOpen: true, inspectorTab: input.activity.inspector, dismissed: false };
  }
  return { inspectorOpen: input.inspectorOpen, dismissed: input.dismissed };
}

export function userClosedInspector(): Pick<DesktopLayoutState, "inspectorOpen"> & { dismissed: true } {
  return { inspectorOpen: false, dismissed: true };
}

export function userOpenedInspector(tab?: InspectorTab): Partial<DesktopLayoutState> & { dismissed: false } {
  return { inspectorOpen: true, ...(tab ? { inspectorTab: tab } : {}), dismissed: false };
}
