// apps/desktop/src/renderer/desktopLayout.ts
//
// Central UI chrome state for the desktop shell. Layout preferences are
// safe to persist locally — they contain no secrets.
//
// One right-hand Agent Workspace. Legacy inspector* / workSurface* keys
// are ignored so stored two-pane state cannot remount a second column.

import {
  isAgentWorkspaceTab,
  type AgentWorkspaceTab,
} from "./agentWorkspaceModel.ts";

export const DESKTOP_LAYOUT_KEY = "orvyn:desktop-layout";

export const TERMINAL_MIN_HEIGHT = 140;
export const TERMINAL_MAX_HEIGHT = 520;
export const TERMINAL_DEFAULT_HEIGHT = 280;

export const AGENT_PANEL_MIN = 360;
export const AGENT_PANEL_DEFAULT = 520;
export const CHAT_MIN = 500;
export const SIDEBAR_WIDTH = 248;

export interface AgentWorkspaceLayout {
  open: boolean;
  width: number;
  activeTab: AgentWorkspaceTab;
  followOrion: boolean;
}

export interface DesktopLayoutState {
  rightPanelOpen: boolean;
  bottomTerminalOpen: boolean;
  bottomTerminalHeight: number;
  helpOpen: boolean;
  agentPanelWidth: number;
  activeTab: AgentWorkspaceTab;
  previewUrl: string;
  followOrion: boolean;
  expandedPreview: boolean;
}

export const DEFAULT_DESKTOP_LAYOUT: DesktopLayoutState = {
  rightPanelOpen: false,
  bottomTerminalOpen: false,
  bottomTerminalHeight: TERMINAL_DEFAULT_HEIGHT,
  helpOpen: false,
  agentPanelWidth: AGENT_PANEL_DEFAULT,
  activeTab: "changes",
  previewUrl: "",
  followOrion: true,
  expandedPreview: false,
};

export function clampTerminalHeight(height: number, viewportHeight = 900): number {
  const max = Math.min(TERMINAL_MAX_HEIGHT, Math.max(TERMINAL_MIN_HEIGHT, Math.floor(viewportHeight * 0.45)));
  if (!Number.isFinite(height)) return TERMINAL_DEFAULT_HEIGHT;
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(max, Math.round(height)));
}

export function clampAgentPanelWidth(width: number, viewportWidth = 1440): number {
  if (!Number.isFinite(width)) return AGENT_PANEL_DEFAULT;
  const maxByVw = Math.floor(viewportWidth * 0.7);
  const room = Math.max(AGENT_PANEL_MIN, viewportWidth - SIDEBAR_WIDTH - CHAT_MIN - 8);
  const max = Math.max(AGENT_PANEL_MIN, Math.min(maxByVw, room));
  return Math.max(AGENT_PANEL_MIN, Math.min(Math.round(width), max));
}

export function shouldOverlayAgentPanel(viewportWidth: number): boolean {
  return viewportWidth < SIDEBAR_WIDTH + CHAT_MIN + AGENT_PANEL_MIN;
}

function safePreviewUrl(value: unknown): string {
  return typeof value === "string" && value.startsWith("http") && value.length < 2000 ? value : "";
}

function migrateActiveTab(rec: Record<string, unknown>): AgentWorkspaceTab {
  if (isAgentWorkspaceTab(rec.activeTab)) return rec.activeTab;
  const surface = typeof rec.surfaceTab === "string" ? rec.surfaceTab : "";
  if (surface.startsWith("preview")) return "preview";
  if (isAgentWorkspaceTab(surface)) return surface;
  const inspector = typeof rec.inspectorTab === "string" ? rec.inspectorTab : "";
  if (isAgentWorkspaceTab(inspector)) return inspector;
  return "changes";
}

function migrateWidth(rec: Record<string, unknown>): number {
  if (Number.isFinite(Number(rec.agentPanelWidth))) return clampAgentPanelWidth(Number(rec.agentPanelWidth));
  if (Number.isFinite(Number(rec.workSurfaceWidth))) return clampAgentPanelWidth(Number(rec.workSurfaceWidth));
  return AGENT_PANEL_DEFAULT;
}

export function parseDesktopLayout(raw: unknown): DesktopLayoutState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DESKTOP_LAYOUT };
  const rec = raw as Record<string, unknown>;
  return {
    rightPanelOpen: rec.rightPanelOpen === true,
    bottomTerminalOpen: rec.bottomTerminalOpen === true,
    bottomTerminalHeight: clampTerminalHeight(Number(rec.bottomTerminalHeight ?? TERMINAL_DEFAULT_HEIGHT)),
    helpOpen: rec.helpOpen === true,
    agentPanelWidth: migrateWidth(rec),
    activeTab: migrateActiveTab(rec),
    previewUrl: safePreviewUrl(rec.previewUrl),
    followOrion: rec.followOrion !== false,
    expandedPreview: rec.expandedPreview === true,
  };
}

export function persistableLayout(state: DesktopLayoutState): Omit<DesktopLayoutState, "helpOpen"> {
  return {
    rightPanelOpen: state.rightPanelOpen,
    bottomTerminalOpen: state.bottomTerminalOpen,
    bottomTerminalHeight: clampTerminalHeight(state.bottomTerminalHeight),
    agentPanelWidth: clampAgentPanelWidth(state.agentPanelWidth, 2400),
    activeTab: isAgentWorkspaceTab(state.activeTab) ? state.activeTab : "changes",
    previewUrl: safePreviewUrl(state.previewUrl),
    followOrion: state.followOrion,
    expandedPreview: state.expandedPreview,
  };
}

export function toAgentWorkspaceLayout(state: DesktopLayoutState): AgentWorkspaceLayout {
  return {
    open: state.rightPanelOpen,
    width: state.agentPanelWidth,
    activeTab: state.activeTab,
    followOrion: state.followOrion,
  };
}

type Listener = (state: DesktopLayoutState) => void;

let state: DesktopLayoutState = { ...DEFAULT_DESKTOP_LAYOUT };
const listeners = new Set<Listener>();
let loaded = false;

function emit(): void {
  listeners.forEach((l) => l(state));
}

function readStorage(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(DESKTOP_LAYOUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(next: DesktopLayoutState): void {
  try {
    globalThis.localStorage?.setItem(DESKTOP_LAYOUT_KEY, JSON.stringify(persistableLayout(next)));
  } catch {
    /* private mode / missing storage */
  }
}

export function loadDesktopLayout(): DesktopLayoutState {
  if (!loaded) {
    state = parseDesktopLayout(readStorage());
    loaded = true;
  }
  return state;
}

export function getDesktopLayout(): DesktopLayoutState {
  return loadDesktopLayout();
}

export function setDesktopLayout(patch: Partial<DesktopLayoutState>): DesktopLayoutState {
  const current = loadDesktopLayout();
  const nextTab = patch.activeTab ?? current.activeTab;
  state = {
    ...current,
    ...patch,
    bottomTerminalHeight: clampTerminalHeight(patch.bottomTerminalHeight ?? current.bottomTerminalHeight),
    agentPanelWidth: clampAgentPanelWidth(
      patch.agentPanelWidth ?? current.agentPanelWidth,
      typeof window !== "undefined" ? window.innerWidth : 1440
    ),
    activeTab: isAgentWorkspaceTab(nextTab) ? nextTab : "changes",
    previewUrl: safePreviewUrl(patch.previewUrl ?? current.previewUrl),
  };
  writeStorage(state);
  emit();
  return state;
}

export function toggleRightPanel(): DesktopLayoutState {
  return setDesktopLayout({ rightPanelOpen: !loadDesktopLayout().rightPanelOpen });
}

export function toggleBottomTerminal(): DesktopLayoutState {
  return setDesktopLayout({ bottomTerminalOpen: !loadDesktopLayout().bottomTerminalOpen });
}

export function toggleHelp(): DesktopLayoutState {
  return setDesktopLayout({ helpOpen: !loadDesktopLayout().helpOpen });
}

export function subscribeDesktopLayout(listener: Listener): () => void {
  loadDesktopLayout();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
