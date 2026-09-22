// apps/desktop/src/renderer/desktopLayout.ts
//
// Central UI chrome state for the desktop shell. Layout preferences are
// safe to persist locally — they contain no secrets.

export const DESKTOP_LAYOUT_KEY = "orvyn:desktop-layout";

export const TERMINAL_MIN_HEIGHT = 140;
export const TERMINAL_MAX_HEIGHT = 520;
export const TERMINAL_DEFAULT_HEIGHT = 280;

export const WORK_SURFACE_MIN = 450;
export const WORK_SURFACE_DEFAULT = 560;
export const INSPECTOR_MIN = 280;
export const INSPECTOR_DEFAULT = 320;
export const CHAT_MIN = 500;
export const SIDEBAR_WIDTH = 222;

export interface DesktopLayoutState {
  rightPanelOpen: boolean;
  bottomTerminalOpen: boolean;
  bottomTerminalHeight: number;
  helpOpen: boolean;
  workSurfaceWidth: number;
  inspectorWidth: number;
  inspectorOpen: boolean;
  inspectorPinned: boolean;
  surfaceTab: string;
  inspectorTab: string;
  followOrion: boolean;
  expandedPreview: boolean;
}

export const DEFAULT_DESKTOP_LAYOUT: DesktopLayoutState = {
  rightPanelOpen: false,
  bottomTerminalOpen: false,
  bottomTerminalHeight: TERMINAL_DEFAULT_HEIGHT,
  helpOpen: false,
  workSurfaceWidth: WORK_SURFACE_DEFAULT,
  inspectorWidth: INSPECTOR_DEFAULT,
  inspectorOpen: false,
  inspectorPinned: false,
  surfaceTab: "changes",
  inspectorTab: "files",
  followOrion: true,
  expandedPreview: false,
};

export function clampTerminalHeight(height: number, viewportHeight = 900): number {
  const max = Math.min(TERMINAL_MAX_HEIGHT, Math.max(TERMINAL_MIN_HEIGHT, Math.floor(viewportHeight * 0.45)));
  if (!Number.isFinite(height)) return TERMINAL_DEFAULT_HEIGHT;
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(max, Math.round(height)));
}

export function clampWorkSurfaceWidth(width: number, viewportWidth = 1440, inspectorOpen = true, inspectorWidth = INSPECTOR_DEFAULT): number {
  if (!Number.isFinite(width)) return WORK_SURFACE_DEFAULT;
  const sidebar = SIDEBAR_WIDTH;
  const inspector = inspectorOpen ? Math.max(INSPECTOR_MIN, inspectorWidth) : 0;
  const max = Math.max(WORK_SURFACE_MIN, Math.floor(viewportWidth * 0.65));
  const room = Math.max(WORK_SURFACE_MIN, viewportWidth - sidebar - CHAT_MIN - inspector - 8);
  return Math.max(WORK_SURFACE_MIN, Math.min(Math.round(width), max, room));
}

export function clampInspectorWidth(width: number, viewportWidth = 1440): number {
  if (!Number.isFinite(width)) return INSPECTOR_DEFAULT;
  const max = Math.min(480, Math.floor(viewportWidth * 0.32));
  return Math.max(INSPECTOR_MIN, Math.min(Math.round(width), max));
}

function safeTab(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length < 400 ? value : fallback;
}

export function parseDesktopLayout(raw: unknown): DesktopLayoutState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DESKTOP_LAYOUT };
  const rec = raw as Partial<DesktopLayoutState> & { inspectorPinned?: unknown };
  const inspectorPinned = rec.inspectorPinned === true;
  // Older builds defaulted Inspector open and had no pin flag — migrate those
  // to a single Work Surface so reopening the app is not a permanent double pane.
  const legacyAlwaysOn = rec.inspectorOpen === true && rec.inspectorPinned === undefined;
  const inspectorOpen = inspectorPinned ? rec.inspectorOpen === true : !legacyAlwaysOn && rec.inspectorOpen === true;
  const inspectorWidth = clampInspectorWidth(Number(rec.inspectorWidth ?? INSPECTOR_DEFAULT));
  return {
    rightPanelOpen: rec.rightPanelOpen === true,
    bottomTerminalOpen: rec.bottomTerminalOpen === true,
    bottomTerminalHeight: clampTerminalHeight(Number(rec.bottomTerminalHeight ?? TERMINAL_DEFAULT_HEIGHT)),
    helpOpen: rec.helpOpen === true,
    inspectorOpen,
    inspectorPinned,
    inspectorWidth,
    workSurfaceWidth: clampWorkSurfaceWidth(Number(rec.workSurfaceWidth ?? WORK_SURFACE_DEFAULT), 1440, inspectorOpen, inspectorWidth),
    surfaceTab: safeTab(rec.surfaceTab, "changes"),
    inspectorTab: safeTab(rec.inspectorTab, "files"),
    followOrion: rec.followOrion !== false,
    expandedPreview: rec.expandedPreview === true,
  };
}

export function persistableLayout(state: DesktopLayoutState): Omit<DesktopLayoutState, "helpOpen"> {
  return {
    rightPanelOpen: state.rightPanelOpen,
    bottomTerminalOpen: state.bottomTerminalOpen,
    bottomTerminalHeight: clampTerminalHeight(state.bottomTerminalHeight),
    workSurfaceWidth: Math.max(WORK_SURFACE_MIN, Math.round(Number(state.workSurfaceWidth) || WORK_SURFACE_DEFAULT)),
    inspectorWidth: clampInspectorWidth(state.inspectorWidth, 2400),
    inspectorOpen: state.inspectorOpen,
    inspectorPinned: state.inspectorPinned,
    surfaceTab: state.surfaceTab,
    inspectorTab: state.inspectorTab,
    followOrion: state.followOrion,
    expandedPreview: state.expandedPreview,
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
  const inspectorOpen = patch.inspectorOpen ?? current.inspectorOpen;
  const inspectorPinned = patch.inspectorPinned ?? current.inspectorPinned;
  const inspectorWidth = clampInspectorWidth(patch.inspectorWidth ?? current.inspectorWidth);
  state = {
    ...current,
    ...patch,
    bottomTerminalHeight: clampTerminalHeight(patch.bottomTerminalHeight ?? current.bottomTerminalHeight),
    inspectorOpen,
    inspectorPinned,
    inspectorWidth,
    workSurfaceWidth: clampWorkSurfaceWidth(
      patch.workSurfaceWidth ?? current.workSurfaceWidth,
      typeof window !== "undefined" ? window.innerWidth : 1440,
      inspectorOpen,
      inspectorWidth
    ),
    surfaceTab: safeTab(patch.surfaceTab ?? current.surfaceTab, "changes"),
    inspectorTab: safeTab(patch.inspectorTab ?? current.inspectorTab, "files"),
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
