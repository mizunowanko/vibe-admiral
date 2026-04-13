/**
 * Context Isolation Registry (ADR-0024).
 *
 * Single reference point for Fleet / cwd / session / customInstructions context.
 * All subprocess launch and resume paths MUST obtain their context from this registry.
 */
import { createHash } from "node:crypto";

export function hashCustomInstructions(text: string | undefined): string {
  if (!text) return "";
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// ── Branded type aliases (documentation-level; runtime-compatible with string) ──

export type FleetId = string & { readonly __brand?: "FleetId" };
export type AbsolutePath = string & { readonly __brand?: "AbsolutePath" };
export type ClaudeSessionId = string & { readonly __brand?: "ClaudeSessionId" };
export type ShipId = string & { readonly __brand?: "ShipId" };

export type UnitKind = "ship" | "commander" | "escort" | "dispatch";

export type CustomInstructionsSource =
  | "fleet"
  | "global"
  | "ship-override"
  | "escort-stash";

export interface UnitContext {
  fleetId: FleetId;
  unitKind: UnitKind;
  unitId: string;
  cwd: AbsolutePath;
  sessionId: ClaudeSessionId | null;
  customInstructionsSource: CustomInstructionsSource;
  customInstructionsHash: string;
}

/**
 * Registry that tracks every active Unit's context.
 * Provides boundary assertions and audited context swaps.
 */
export class ContextRegistry {
  private contexts = new Map<string, UnitContext>();

  register(ctx: UnitContext): void {
    this.contexts.set(ctx.unitId, ctx);
    console.log(
      `[context-registry] Registered ${ctx.unitKind} ${ctx.unitId.slice(0, 8)}... ` +
      `(fleet=${ctx.fleetId.slice(0, 8)}..., cwd=${ctx.cwd})`,
    );
  }

  get(unitId: string): UnitContext | null {
    return this.contexts.get(unitId) ?? null;
  }

  /**
   * Assert that a Unit's context matches expected values.
   * Throws if any provided field does not match the registered context.
   */
  assertBoundary(unitId: string, expected: Partial<UnitContext>): void {
    const ctx = this.contexts.get(unitId);
    if (!ctx) {
      throw new Error(`[context-registry] No context registered for unit ${unitId}`);
    }
    for (const [key, value] of Object.entries(expected)) {
      const actual = ctx[key as keyof UnitContext];
      if (actual !== value) {
        throw new Error(
          `[context-registry] Boundary violation for ${unitId.slice(0, 8)}...: ` +
          `expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
        );
      }
    }
  }

  /**
   * Swap a context field with audit logging.
   * Returns the previous value.
   */
  swap<K extends keyof UnitContext>(
    unitId: string,
    field: K,
    newValue: UnitContext[K],
    reason: string,
  ): UnitContext[K] {
    const ctx = this.contexts.get(unitId);
    if (!ctx) {
      throw new Error(`[context-registry] No context registered for unit ${unitId}`);
    }
    const previous = ctx[field];
    ctx[field] = newValue;
    console.log(
      `[context-registry] Swap ${field} for ${ctx.unitKind} ${unitId.slice(0, 8)}...: ` +
      `${JSON.stringify(previous)} → ${JSON.stringify(newValue)} (reason: ${reason})`,
    );
    return previous;
  }

  unregister(unitId: string): void {
    const ctx = this.contexts.get(unitId);
    if (ctx) {
      console.log(
        `[context-registry] Unregistered ${ctx.unitKind} ${unitId.slice(0, 8)}...`,
      );
    }
    this.contexts.delete(unitId);
  }

  /** Get all contexts for a given fleet (useful for fleet-level operations). */
  getByFleet(fleetId: FleetId): UnitContext[] {
    return [...this.contexts.values()].filter((c) => c.fleetId === fleetId);
  }

  /** Check if any unit in the given fleet has the specified cwd. */
  hasConflictingCwd(fleetId: FleetId, cwd: AbsolutePath, excludeUnitId?: string): boolean {
    return [...this.contexts.values()].some(
      (c) => c.fleetId === fleetId && c.cwd === cwd && c.unitId !== excludeUnitId,
    );
  }
}
