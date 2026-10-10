/** Split limits use the available chat container, not the full browser width. */
export const DEFAULT_WORKSPACE_SHARE = 0.44;
export function workspaceBounds(containerWidth: number): { min: number; max: number } {
  const available = Math.max(0, containerWidth - 8);
  const min = Math.min(300, available / 2);
  return { min, max: Math.max(min, available - Math.min(320, available / 2)) };
}
export function workspaceWidth(containerWidth: number, share: number): number {
  const { min, max } = workspaceBounds(containerWidth);
  const requested = containerWidth * (Number.isFinite(share) ? share : DEFAULT_WORKSPACE_SHARE);
  return Math.round(Math.max(min, Math.min(max, requested)));
}
export function storedWorkspaceShare(value: string | null): number {
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 0.9 ? parsed : DEFAULT_WORKSPACE_SHARE;
}
