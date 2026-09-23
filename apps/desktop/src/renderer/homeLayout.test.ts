import { test } from "node:test";
import assert from "node:assert/strict";
import { appGridTemplateColumns, SIDEBAR_WIDTH } from "./desktopLayout.ts";
import {
  HOME_COMPOSER_MAX_PX,
  HOME_HERO_MAX_PX,
  HOME_SEARCH_MIN_PX,
  HOME_SUBMIT_MIN_PX,
  appGridTemplateColumns as homeGrid,
  gridTrackCount,
  homeComposerWidth,
  homeLayoutAt,
  homeMainColumnWidth,
  measureComposerBar,
  workbenchReservesColumn,
} from "./homeLayout.ts";

const VIEWPORTS = [1920, 1600, 1440, 1280] as const;

test("Home hero and composer stay inside the approved max widths", () => {
  assert.equal(HOME_HERO_MAX_PX >= 1200 && HOME_HERO_MAX_PX <= 1320, true);
  assert.equal(HOME_COMPOSER_MAX_PX >= 1080 && HOME_COMPOSER_MAX_PX <= 1160, true);
  assert.ok(HOME_COMPOSER_MAX_PX <= HOME_HERO_MAX_PX);
  assert.ok(HOME_SEARCH_MIN_PX >= 160);
});

test("closed Workbench never reserves a third grid track", () => {
  const closed = appGridTemplateColumns({ workbenchOpen: false, overlay: false, workbenchWidth: 650 });
  assert.equal(closed, `${SIDEBAR_WIDTH}px minmax(0, 1fr)`);
  assert.equal(gridTrackCount(closed), 2);
  assert.equal(closed.includes("650px"), false);
  assert.equal(workbenchReservesColumn(false), false);
  assert.equal(homeGrid({ workbenchOpen: false, workbenchWidth: 900 }), closed);
});

test("open Workbench is sidebar | main | panel — overlay still two tracks", () => {
  const open = appGridTemplateColumns({ workbenchOpen: true, overlay: false, workbenchWidth: 650 });
  assert.equal(gridTrackCount(open), 3);
  assert.ok(open.includes("minmax(0, 650px)"));
  const overlay = appGridTemplateColumns({ workbenchOpen: true, overlay: true, workbenchWidth: 650 });
  assert.equal(gridTrackCount(overlay), 2);
  assert.equal(workbenchReservesColumn(true, false), true);
});

test("Home column ignores Workbench width when the panel is closed", () => {
  for (const vw of VIEWPORTS) {
    const closed = homeMainColumnWidth(vw, false, 900);
    assert.equal(closed, vw - SIDEBAR_WIDTH);
    const open = homeMainColumnWidth(vw, true, 650);
    assert.ok(open <= closed);
    assert.equal(open, vw - SIDEBAR_WIDTH - 650);
  }
});

test("1920 / 1600 / 1440 / 1280: composer is bounded, submit fits, no overflow", () => {
  for (const vw of VIEWPORTS) {
    const layout = homeLayoutAt(vw, false, 650);
    assert.equal(layout.tracks, 2);
    assert.equal(layout.reservedWorkbench, false);
    assert.ok(layout.hero <= HOME_HERO_MAX_PX, `${vw} hero ${layout.hero}`);
    assert.ok(layout.composer <= HOME_COMPOSER_MAX_PX, `${vw} composer ${layout.composer}`);
    assert.ok(layout.composer <= layout.hero);
    assert.ok(layout.hero <= layout.column);

    const nowrap = measureComposerBar({
      composerWidth: layout.composer,
      leftControlsWidth: 420,
      toolsWidth: 360,
      submitWidth: HOME_SUBMIT_MIN_PX,
      wrap: false,
    });
    const wrap = measureComposerBar({
      composerWidth: layout.composer,
      leftControlsWidth: 420,
      toolsWidth: 280,
      submitWidth: HOME_SUBMIT_MIN_PX,
      wrap: true,
    });
    assert.equal(wrap.submitVisible, true, `${vw} wrapped submit must stay visible`);
    assert.equal(wrap.overflowX, 0, `${vw} wrapped bar must not overflow`);
    assert.ok(wrap.submitRight <= layout.composer);
    if (nowrap.overflowX > 0) {
      assert.equal(nowrap.submitVisible, false);
    }
  }
});

test("wide 2560 display keeps Home centered and does not stretch", () => {
  const layout = homeLayoutAt(2560, false, 650);
  assert.equal(layout.hero, HOME_HERO_MAX_PX);
  assert.equal(layout.composer, HOME_COMPOSER_MAX_PX);
  assert.ok(layout.column > layout.hero);
});

test("Workbench open shrinks the Home column without using viewport-width math", () => {
  const closed = homeLayoutAt(1920, false, 650);
  const open = homeLayoutAt(1920, true, 650);
  assert.equal(closed.tracks, 2);
  assert.equal(open.tracks, 3);
  assert.ok(open.column < closed.column);
  assert.ok(open.composer <= open.hero);
  assert.ok(open.hero <= open.column);
  const wrap = measureComposerBar({
    composerWidth: open.composer,
    leftControlsWidth: 400,
    toolsWidth: 260,
    submitWidth: HOME_SUBMIT_MIN_PX,
    wrap: true,
  });
  assert.equal(wrap.submitVisible, true);
  assert.equal(wrap.overflowX, 0);
});

test("composer width is a function of the column, never 88vw of the window", () => {
  const column = homeMainColumnWidth(1920, true, 650);
  const hero = homeComposerWidth(homeLayoutAt(1920, true, 650).hero);
  const eightyEightVw = Math.round(1920 * 0.88);
  assert.ok(column < eightyEightVw);
  assert.ok(hero <= column);
  assert.ok(hero < eightyEightVw);
});
