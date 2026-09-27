// What a preview.updated event should do to the Workbench Browser.
// Refresh the tab that already shows the preview. Do not open another one.

export interface PreviewRefreshTab {
  id: string;
  url?: string;
}

export interface PreviewRefreshPlan {
  reloadId: string;
  /** Follow ORION may keep the preview in view. A paused follow must not steal focus. */
  focus: boolean;
  revision: number;
}

function samePreviewUrl(a: string, b: string): boolean {
  const clean = (value: string) => value.trim().replace(/\/+$/, "");
  return clean(a) === clean(b);
}

export function planPreviewRefresh(input: {
  url: string;
  revision: number;
  tabs: PreviewRefreshTab[];
  followActive: boolean;
  seenRevision?: number;
}): PreviewRefreshPlan | null {
  if (!input.url || !Number.isFinite(input.revision)) return null;
  if (input.revision <= (input.seenRevision ?? 0)) return null;
  const match = input.tabs.find((tab) => tab.url && samePreviewUrl(tab.url, input.url));
  if (!match) return null;
  return { reloadId: match.id, focus: input.followActive, revision: input.revision };
}
