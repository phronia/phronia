/**
 * Minimal semantic-version parsing and range matching for harness detection.
 *
 * Only the ranges adapters declare are supported: comparators (`>=`, `>`,
 * `<=`, `<`, `=`), `^`, `~`, and space-separated AND. Ranges are written by
 * us, not by users, so a small parser is safer than a dependency.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(input: string): Semver | null {
  const match = /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)/.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*") return true;
  return trimmed.split(/\s+/).every((token) => matchesComparator(parsed, token));
}

function matchesComparator(version: Semver, token: string): boolean {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!match) return false;
  const operator = match[1] ?? "=";
  const target = parseSemver(match[2] ?? "");
  if (!target) return false;
  switch (operator) {
    case ">=":
      return compareSemver(version, target) >= 0;
    case ">":
      return compareSemver(version, target) > 0;
    case "<=":
      return compareSemver(version, target) <= 0;
    case "<":
      return compareSemver(version, target) < 0;
    case "=":
      return compareSemver(version, target) === 0;
    case "^":
      return (
        compareSemver(version, target) >= 0 &&
        version.major === target.major
      );
    case "~":
      return (
        compareSemver(version, target) >= 0 &&
        version.major === target.major &&
        version.minor === target.minor
      );
    default:
      return false;
  }
}
