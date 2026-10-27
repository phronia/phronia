/**
 * Structured diagnostics for the read-only state layer.
 *
 * State reads never throw on bad input. Every degraded path becomes a
 * diagnostic with a stable code so callers (context assembly, doctor, tests)
 * can assert behaviour without matching prose.
 */

export type Severity = "info" | "warn" | "error";

export interface Diagnostic {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];

  add(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  addAll(diagnostics: readonly Diagnostic[]): void {
    this.items.push(...diagnostics);
  }

  all(): readonly Diagnostic[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }
}

export function diagnostic(
  code: string,
  severity: Severity,
  message: string,
  extra: Pick<Diagnostic, "path" | "details"> = {},
): Diagnostic {
  return { code, severity, message, ...extra };
}
