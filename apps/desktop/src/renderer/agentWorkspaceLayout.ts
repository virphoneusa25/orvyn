// apps/desktop/src/renderer/agentWorkspaceLayout.ts
//
// Single authority for the right-hand Agent Workspace.
// Follow ORION changes activeTab only. There is never a second column.

import type { AgentWorkspaceTab, WorkspaceActivity } from "./agentWorkspaceModel.ts";
import type { AgentWorkspaceLayout, DesktopLayoutState } from "./desktopLayout.ts";
import { AGENT_PANEL_DEFAULT, AGENT_PANEL_MIN, CHAT_MIN, SIDEBAR_WIDTH } from "./desktopLayout.ts";

export const AGENT_WORKSPACE_TEST_ID = "agent-workspace";
export const AGENT_WORKSPACE_TABBAR_TEST_ID = "agent-workspace-tabbar";
export const INSPECTOR_PANEL_TEST_ID = "inspector-panel";

export function countRightColumns(state: Pick<DesktopLayoutState, "rightPanelOpen"> | Pick<AgentWorkspaceLayout, "open">): 0 | 1 {
  const open = "rightPanelOpen" in state ? state.rightPanelOpen : state.open;
  return open ? 1 : 0;
}

export function followActiveTab(activity: WorkspaceActivity | null | undefined, current: AgentWorkspaceTab): AgentWorkspaceTab {
  if (!activity || activity.switchTab === false) return current;
  return activity.tab;
}

export function nextWorkspaceLayout(
  current: AgentWorkspaceLayout & { followPaused?: boolean },
  activity: WorkspaceActivity | null | undefined
): AgentWorkspaceLayout & { columns: 0 | 1 } {
  const columns = countRightColumns(current);
  if (!current.followOrion || current.followPaused || !activity || activity.switchTab === false) {
    return { open: current.open, width: current.width, activeTab: current.activeTab, followOrion: current.followOrion, columns };
  }
  return { open: current.open, width: current.width, activeTab: activity.tab, followOrion: current.followOrion, columns };
}

export function visibleWorkspaceViews(activeTab: AgentWorkspaceTab): AgentWorkspaceTab[] {
  return [activeTab];
}

export function simultaneousRightViews(activeTab: AgentWorkspaceTab): {
  changes: boolean;
  review: boolean;
  preview: boolean;
  diff: boolean;
  files: boolean;
  terminal: boolean;
  browser: boolean;
} {
  return {
    changes: activeTab === "changes",
    review: activeTab === "review",
    preview: activeTab === "preview",
    diff: activeTab === "diff",
    files: activeTab === "files",
    terminal: activeTab === "terminal",
    browser: activeTab === "browser",
  };
}

export function countAgentWorkspaces(root: ParentNode): number {
  return root.querySelectorAll(`[data-testid="${AGENT_WORKSPACE_TEST_ID}"]`).length;
}

export function countInspectorPanels(root: ParentNode): number {
  return root.querySelectorAll(`[data-testid="${INSPECTOR_PANEL_TEST_ID}"]`).length;
}

export function assertSingleAgentWorkspace(root: ParentNode): void {
  const workspaces = countAgentWorkspaces(root);
  if (workspaces > 1) {
    throw new Error(`Expected at most one agent-workspace, found ${workspaces}`);
  }
  const inspectors = countInspectorPanels(root);
  if (inspectors > 0) {
    throw new Error(`Legacy inspector-panel must not be mounted, found ${inspectors}`);
  }
}

export function workspaceMarkupContract(html: string): { workspaces: number; inspectors: number; tabbars: number } {
  return {
    workspaces: (html.match(/data-testid="agent-workspace"/g) ?? []).length,
    inspectors: (html.match(/data-testid="inspector-panel"/g) ?? []).length,
    tabbars: (html.match(/data-testid="agent-workspace-tabbar"/g) ?? []).length,
  };
}

export function shouldOverlayAgentPanel(viewportWidth: number): boolean {
  return viewportWidth < SIDEBAR_WIDTH + CHAT_MIN + AGENT_PANEL_MIN;
}

export function agentPanelPlacement(viewportWidth: number, open: boolean): "hidden" | "dock" | "overlay" {
  if (!open) return "hidden";
  return shouldOverlayAgentPanel(viewportWidth) ? "overlay" : "dock";
}

export const defaultWorkspaceLayout: AgentWorkspaceLayout = {
  open: false,
  width: AGENT_PANEL_DEFAULT,
  activeTab: "changes",
  followOrion: true,
};
