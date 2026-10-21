/**
 * Golden parity helpers.
 *
 * During B2/B3 the legacy Python implementation and the new TypeScript core
 * run side by side. Parity means: after normalizing volatile values, the two
 * outputs are structurally identical. Differences must be explicit and
 * reviewed, never masked.
 */

export interface NormalizeOptions {
  /** JSON-pointer-like paths to replace with `<IGNORED>`. Supports `a/*`. */
  ignorePaths?: readonly string[];
  /** Replace ISO-8601 timestamps with `<TIMESTAMP>`. */
  normalizeTimestamps?: boolean;
  /** Sort arrays by their JSON representation (only for order-insensitive data). */
  sortArrays?: boolean;
  /** Additional string substitutions applied to every string value. */
  replacements?: ReadonlyArray<readonly [RegExp, string]>;
}

export type DifferenceKind =
  | "missing-left"
  | "missing-right"
  | "type"
  | "value"
  | "array-length";

export interface Difference {
  path: string;
  kind: DifferenceKind;
  left?: unknown;
  right?: unknown;
}

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalize(value: unknown, options: NormalizeOptions = {}): unknown {
  return normalizeValue(value, "", options);
}

export function diff(left: unknown, right: unknown): Difference[] {
  const differences: Difference[] = [];
  compareValues(left, right, "", differences);
  return differences;
}

export function assertEquivalent(
  left: unknown,
  right: unknown,
  options: NormalizeOptions = {},
): void {
  const differences = diff(normalize(left, options), normalize(right, options));
  if (differences.length > 0) {
    throw new Error(`Parity mismatch:\n${formatDifferences(differences)}`);
  }
}

export function formatDifferences(differences: readonly Difference[]): string {
  return differences
    .map((difference) => {
      const where = difference.path === "" ? "<root>" : difference.path;
      switch (difference.kind) {
        case "missing-left":
          return `  ${where}: missing on left (right=${describe(difference.right)})`;
        case "missing-right":
          return `  ${where}: missing on right (left=${describe(difference.left)})`;
        case "array-length":
          return `  ${where}: array length differs (left=${describe(difference.left)}, right=${describe(difference.right)})`;
        case "type":
          return `  ${where}: type differs (left=${describe(difference.left)}, right=${describe(difference.right)})`;
        case "value":
          return `  ${where}: value differs (left=${describe(difference.left)}, right=${describe(difference.right)})`;
      }
    })
    .join("\n");
}

function normalizeValue(
  value: unknown,
  pointer: string,
  options: NormalizeOptions,
): unknown {
  if (isIgnored(pointer, options.ignorePaths ?? [])) {
    return "<IGNORED>";
  }

  if (typeof value === "string") {
    let result = value;
    if (options.normalizeTimestamps && ISO_TIMESTAMP.test(result)) {
      return "<TIMESTAMP>";
    }
    for (const [pattern, replacement] of options.replacements ?? []) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  if (Array.isArray(value)) {
    const normalized = value.map((item, index) =>
      normalizeValue(item, `${pointer}/${index}`, options),
    );
    if (options.sortArrays) {
      normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return normalized;
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeValue(value[key], `${pointer}/${escapePointer(key)}`, options);
    }
    return result;
  }

  return value;
}

function compareValues(
  left: unknown,
  right: unknown,
  pointer: string,
  out: Difference[],
): void {
  if (left === undefined && right === undefined) {
    return;
  }
  if (left === undefined) {
    out.push({ path: pointer, kind: "missing-left", right });
    return;
  }
  if (right === undefined) {
    out.push({ path: pointer, kind: "missing-right", left });
    return;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      out.push({ path: pointer, kind: "type", left, right });
      return;
    }
    if (left.length !== right.length) {
      out.push({ path: pointer, kind: "array-length", left: left.length, right: right.length });
    }
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      compareValues(left[index], right[index], `${pointer}/${index}`, out);
    }
    return;
  }

  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      out.push({ path: pointer, kind: "type", left, right });
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      compareValues(
        left[key],
        right[key],
        `${pointer}/${escapePointer(key)}`,
        out,
      );
    }
    return;
  }

  if (typeof left !== typeof right) {
    out.push({ path: pointer, kind: "type", left, right });
    return;
  }
  if (left !== right) {
    out.push({ path: pointer, kind: "value", left, right });
  }
}

function isIgnored(pointer: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === pointer) {
      return true;
    }
    if (pattern.endsWith("/*") && pointer.startsWith(pattern.slice(0, -1))) {
      return true;
    }
    if (pattern.endsWith("*") && pointer.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return String(value);
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
