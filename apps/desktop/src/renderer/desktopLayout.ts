// apps/desktop/src/renderer/desktopLayout.ts
//
// Central UI chrome state for the desktop shell. Layout preferences are
// safe to persist locally — they contain no secrets.

export const DESKTOP_LAYOUT_KEY = "orvyn:desktop-layout";

export const TERMINAL_MIN_HEIGHT = 140;
export const TERMINAL_MAX_HEIGHT = 520;
export const TERMINAL_DEFAULT_HEIGHT = 280;

export interface DesktopLayoutState {
  rightPanelOpen: boolean;
  bottomTerminalOpen: boolean;
  bottomTerminalHeight: number;
  helpOpen: boolean;
}

export const DEFAULT_DESKTOP_LAYOUT: DesktopLayoutState = {
  rightPanelOpen: true,
  bottomTerminalOpen: false,
  bottomTerminalHeight: TERMINAL_DEFAULT_HEIGHT,
  helpOpen: false,
};

export function clampTerminalHeight(height: number, viewportHeight = 900): number {
  const max = Math.min(TERMINAL_MAX_HEIGHT, Math.max(TERMINAL_MIN_HEIGHT, Math.floor(viewportHeight * 0.45)));
  if (!Number.isFinite(height)) return TERMINAL_DEFAULT_HEIGHT;
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(max, Math.round(height)));
}

export function parseDesktopLayout(raw: unknown): DesktopLayoutState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DESKTOP_LAYOUT };
  const rec = raw as Partial<DesktopLayoutState>;
  return {
    rightPanelOpen: rec.rightPanelOpen !== false,
    bottomTerminalOpen: rec.bottomTerminalOpen === true,
    bottomTerminalHeight: clampTerminalHeight(Number(rec.bottomTerminalHeight ?? TERMINAL_DEFAULT_HEIGHT)),
    helpOpen: rec.helpOpen === true,
  };
}

export function persistableLayout(state: DesktopLayoutState): Omit<DesktopLayoutState, "helpOpen"> {
  return {
    rightPanelOpen: state.rightPanelOpen,
    bottomTerminalOpen: state.bottomTerminalOpen,
    bottomTerminalHeight: clampTerminalHeight(state.bottomTerminalHeight),
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
  state = {
    ...current,
    ...patch,
    bottomTerminalHeight: clampTerminalHeight(patch.bottomTerminalHeight ?? current.bottomTerminalHeight),
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
