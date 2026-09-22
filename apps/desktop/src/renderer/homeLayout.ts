// Home composition constants — the approved centered mission-control layout.
// CSS in redesign.css must keep the same numbers. Workbench width never
// participates when the panel is closed: Home is measured against the
// main column (viewport − sidebar), never 88vw of the whole window.

import { appGridTemplateColumns, SIDEBAR_WIDTH } from "./desktopLayout.ts";

export { appGridTemplateColumns };

/** Hero / greeting column. Approved range 1200–1320. */
export const HOME_HERO_MAX_PX = 1260;
/** Mission composer. Approved range 1080–1160. */
export const HOME_COMPOSER_MAX_PX = 1120;
/** Top-bar search must stay readable. */
export const HOME_SEARCH_MIN_PX = 200;
export const HOME_HERO_PAD_INLINE_WIDE = 64;
export const HOME_HERO_PAD_INLINE_NARROW = 40;
export const HOME_NARROW_VIEWPORT = 1100;
/** Run mission button approximate width including padding/icon. */
export const HOME_SUBMIT_MIN_PX = 132;

export function homeMainColumnWidth(
  viewportWidth: number,
  workbenchOpen: boolean,
  workbenchWidth = 0
): number {
  const rest = Math.max(0, viewportWidth - SIDEBAR_WIDTH);
  if (!workbenchOpen) return rest;
  return Math.max(0, rest - Math.max(0, workbenchWidth));
}

export function homeHeroPad(viewportWidth: number): number {
  return viewportWidth <= HOME_NARROW_VIEWPORT ? HOME_HERO_PAD_INLINE_NARROW : HOME_HERO_PAD_INLINE_WIDE;
}

export function homeHeroWidth(columnWidth: number, viewportWidth = 1920): number {
  const inner = Math.max(0, columnWidth - homeHeroPad(viewportWidth));
  return Math.min(HOME_HERO_MAX_PX, inner);
}

export function homeComposerWidth(heroWidth: number): number {
  return Math.min(HOME_COMPOSER_MAX_PX, Math.max(0, heroWidth));
}

export function workbenchReservesColumn(workbenchOpen: boolean, overlay = false): boolean {
  return workbenchOpen && !overlay;
}

export function gridTrackCount(template: string): number {
  const tracks: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of template.trim()) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === " " && depth === 0) {
      if (current) tracks.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tracks.push(current);
  return tracks.length;
}

/**
 * Control-row geometry. The Home bar wraps; submit is flex-shrink: 0
 * on the trailing cluster. A nowrap row (the regression) overflows
 * whenever left + right exceed the composer.
 */
export function measureComposerBar(opts: {
  composerWidth: number;
  leftControlsWidth: number;
  toolsWidth: number;
  submitWidth: number;
  wrap: boolean;
}): { overflowX: number; submitVisible: boolean; submitRight: number } {
  const submit = Math.max(0, opts.submitWidth);
  if (!opts.wrap) {
    const total = opts.leftControlsWidth + opts.toolsWidth + submit;
    const overflowX = Math.max(0, total - opts.composerWidth);
    const submitRight = opts.leftControlsWidth + opts.toolsWidth + submit;
    return {
      overflowX,
      submitVisible: submitRight <= opts.composerWidth && overflowX === 0,
      submitRight,
    };
  }
  const toolsRow = opts.toolsWidth + submit;
  const row1 = Math.min(opts.leftControlsWidth, opts.composerWidth);
  const row2 = Math.min(toolsRow, opts.composerWidth);
  const overflowX = Math.max(0, row1 - opts.composerWidth, toolsRow - opts.composerWidth);
  const submitVisible = opts.composerWidth >= submit && overflowX === 0;
  return {
    overflowX,
    submitVisible,
    submitRight: Math.min(opts.composerWidth, row2),
  };
}

export function homeLayoutAt(viewportWidth: number, workbenchOpen = false, workbenchWidth = 650): {
  column: number;
  hero: number;
  composer: number;
  reservedWorkbench: boolean;
  tracks: number;
} {
  const column = homeMainColumnWidth(viewportWidth, workbenchOpen, workbenchWidth);
  const hero = homeHeroWidth(column, viewportWidth);
  const composer = homeComposerWidth(hero);
  const reservedWorkbench = workbenchReservesColumn(workbenchOpen);
  const tracks = gridTrackCount(
    appGridTemplateColumns({ workbenchOpen, overlay: false, workbenchWidth })
  );
  return { column, hero, composer, reservedWorkbench, tracks };
}
