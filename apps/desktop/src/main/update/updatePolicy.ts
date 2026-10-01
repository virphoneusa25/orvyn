export function parseSemver(version: string): { major: number; minor: number; patch: number; pre: string } | null {
  const m = String(version ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" };
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  return left.pre.localeCompare(right.pre);
}

export function isBelowMinimum(current: string, minimum?: string): boolean {
  if (!minimum) return false;
  return compareSemver(current, minimum) < 0;
}

export function requiredUpdateBlocksCloud(input: { currentVersion: string; minimumSupportedVersion?: string; required?: boolean }): boolean {
  if (!input.required && !input.minimumSupportedVersion) return false;
  return isBelowMinimum(input.currentVersion, input.minimumSupportedVersion);
}

export function isOptionalUpdate(input: { required?: boolean; minimumSupportedVersion?: string; currentVersion: string }): boolean {
  return !requiredUpdateBlocksCloud(input);
}

export function inStagedRollout(rolloutPercent: number, installationId: string): boolean {
  const n = Math.max(0, Math.min(100, Math.floor(Number(rolloutPercent) || 0)));
  if (n >= 100) return true;
  if (n <= 0) return false;
  let h = 0;
  for (const ch of String(installationId)) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return h % 100 < n;
}

export function canPostpone(required: boolean): boolean {
  return !required;
}
