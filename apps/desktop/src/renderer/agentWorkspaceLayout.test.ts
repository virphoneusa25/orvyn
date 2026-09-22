import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countRightColumns,
  decideInspectorFollow,
  inspectorOpenForRun,
  inspectorPlacement,
  isMeaningfulInspectorActivity,
  surfacePrefersClosedInspector,
  userClosedInspector,
  userOpenedInspector,
} from "./agentWorkspaceLayout.ts";
import { parseDesktopLayout } from "./desktopLayout.ts";

test("opening the Work Surface alone does not render Inspector", () => {
  const openSurface = parseDesktopLayout({ rightPanelOpen: true });
  assert.equal(openSurface.rightPanelOpen, true);
  assert.equal(openSurface.inspectorOpen, false);
  assert.equal(openSurface.inspectorPinned, false);
  assert.equal(countRightColumns(openSurface), 1);
});

test("legacy always-on inspector migrates to a single right column", () => {
  const legacy = parseDesktopLayout({ rightPanelOpen: true, inspectorOpen: true });
  assert.equal(legacy.inspectorOpen, false);
  assert.equal(countRightColumns(legacy), 1);
});

test("explicit pin keeps Inspector open across parse", () => {
  const pinned = parseDesktopLayout({
    rightPanelOpen: true,
    inspectorOpen: true,
    inspectorPinned: true,
  });
  assert.equal(pinned.inspectorOpen, true);
  assert.equal(pinned.inspectorPinned, true);
  assert.equal(countRightColumns(pinned), 2);
});

test("closing Inspector returns to one right-side column", () => {
  const closed = userClosedInspector();
  assert.equal(closed.inspectorOpen, false);
  assert.equal(countRightColumns({ rightPanelOpen: true, inspectorOpen: closed.inspectorOpen }), 1);
  const opened = userOpenedInspector("diff");
  assert.equal(opened.inspectorOpen, true);
  assert.equal(opened.inspectorTab, "diff");
  assert.equal(countRightColumns({ rightPanelOpen: true, inspectorOpen: true }), 2);
});

test("Follow ORION opens Inspector only for meaningful detail", () => {
  const edit = { line: "Editing App.tsx", priority: 70, surface: "changes" as const, inspector: "diff" as const, file: "App.tsx" };
  const read = { line: "Reading readme.md", priority: 20, surface: "changes" as const, inspector: "files" as const, file: "readme.md" };
  assert.equal(isMeaningfulInspectorActivity(edit), true);
  assert.equal(isMeaningfulInspectorActivity(read), false);

  const afterEdit = decideInspectorFollow({
    pinned: false,
    inspectorOpen: false,
    dismissed: false,
    activity: edit,
    surfaceId: "changes",
  });
  assert.equal(afterEdit.inspectorOpen, true);
  assert.equal(afterEdit.inspectorTab, "diff");

  const afterRead = decideInspectorFollow({
    pinned: false,
    inspectorOpen: false,
    dismissed: false,
    activity: read,
    surfaceId: "changes",
  });
  assert.equal(afterRead.inspectorOpen, false);
});

test("user close is not reopened by trivial follow events", () => {
  const next = decideInspectorFollow({
    pinned: false,
    inspectorOpen: false,
    dismissed: true,
    activity: { line: "Reading a.ts", priority: 20, surface: "changes", inspector: "files" },
    surfaceId: "changes",
  });
  assert.equal(next.inspectorOpen, false);
  assert.equal(next.dismissed, true);
});

test("preview/browser/desktop close unpinned Inspector", () => {
  assert.equal(surfacePrefersClosedInspector("preview"), true);
  assert.equal(surfacePrefersClosedInspector("preview:http://127.0.0.1:5173"), true);
  assert.equal(surfacePrefersClosedInspector("browser"), true);
  assert.equal(surfacePrefersClosedInspector("changes"), false);
  const next = decideInspectorFollow({
    pinned: false,
    inspectorOpen: true,
    dismissed: false,
    activity: { line: "Inspecting localhost", priority: 80, surface: "preview", inspector: "files" },
    surfaceId: "preview:http://127.0.0.1:5173",
  });
  assert.equal(next.inspectorOpen, false);
});

test("pinned Inspector stays open on preview", () => {
  const next = decideInspectorFollow({
    pinned: true,
    inspectorOpen: true,
    dismissed: false,
    activity: { line: "Inspecting localhost", priority: 80, surface: "preview", inspector: "files" },
    surfaceId: "preview",
  });
  assert.equal(next.inspectorOpen, true);
});

test("awaiting approval does not open Review Inspector", () => {
  const approval = { line: "Waiting for approval · terminal", priority: 100, surface: "changes" as const, inspector: "files" as const, openInspector: false as const };
  assert.equal(isMeaningfulInspectorActivity(approval), false);
  const next = decideInspectorFollow({
    pinned: false,
    inspectorOpen: false,
    dismissed: false,
    activity: approval,
    surfaceId: "changes",
  });
  assert.equal(next.inspectorOpen, false);
  assert.equal(
    inspectorOpenForRun({
      runStatus: "awaiting_approval",
      rightPanelOpen: true,
      inspectorPinned: false,
      inspectorOpen: false,
    }),
    false
  );
  assert.equal(
    inspectorOpenForRun({
      runStatus: "awaiting_approval",
      rightPanelOpen: true,
      inspectorPinned: false,
      inspectorOpen: false,
      explicitContext: true,
    }),
    true
  );
});

test("narrow windows overlay Inspector instead of crushing chat", () => {
  assert.equal(inspectorPlacement(1920, true, 560), "dock");
  assert.equal(inspectorPlacement(1280, true, 560), "overlay");
  assert.equal(inspectorPlacement(1600, false, 560), "hidden");
});
