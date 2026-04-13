/**
 * SystemPromptRegistry — unified customInstructions composition (ADR-0024).
 *
 * Consolidates injection paths from:
 * - commander.ts deployRules() (wraps with "## Custom Instructions\n\n")
 * - ship-manager.ts deployRules() (no wrapper)
 * - escort-manager.ts deployCustomInstructions() (no wrapper)
 * - ship-internal-api.ts (assembles from CI parts)
 */
import { createHash } from "node:crypto";
import type { UnitKind } from "./context-registry.js";
import type { CustomInstructions } from "./types.js";

export interface SystemPromptSource {
  origin: "fleet" | "global" | "ship-override" | "escort-override";
  field: keyof CustomInstructions | "composed";
  hash: string;
}

export interface ComposeResult {
  text: string | undefined;
  sourceAudit: SystemPromptSource[];
}

/**
 * Compose customInstructions for a specific unit kind.
 *
 * Assembly rules per unit kind:
 * - commander (dock/flagship): shared + role-specific, wrapped with "## Custom Instructions"
 * - ship: shared + ship-specific, NO wrapper (Ship's deployRules writes raw text)
 * - escort: shared + escort-specific, wrapped with "## Custom Instructions"
 */
export function compose(opts: {
  unitKind: UnitKind;
  customInstructions?: CustomInstructions;
  role?: "dock" | "flagship";
}): ComposeResult {
  const { unitKind, customInstructions: ci, role } = opts;
  const sourceAudit: SystemPromptSource[] = [];

  if (!ci) {
    return { text: undefined, sourceAudit };
  }

  const parts: string[] = [];

  if (ci.shared) {
    parts.push(ci.shared);
    sourceAudit.push({
      origin: "fleet",
      field: "shared",
      hash: hashContent(ci.shared),
    });
  }

  switch (unitKind) {
    case "commander": {
      const roleText = role === "dock" ? ci.dock : ci.flagship;
      if (roleText) {
        parts.push(roleText);
        sourceAudit.push({
          origin: "fleet",
          field: role === "dock" ? "dock" : "flagship",
          hash: hashContent(roleText),
        });
      }
      break;
    }
    case "ship": {
      if (ci.ship) {
        parts.push(ci.ship);
        sourceAudit.push({
          origin: "fleet",
          field: "ship",
          hash: hashContent(ci.ship),
        });
      }
      break;
    }
    case "escort": {
      if (ci.escort) {
        parts.push(ci.escort);
        sourceAudit.push({
          origin: "fleet",
          field: "escort",
          hash: hashContent(ci.escort),
        });
      }
      break;
    }
    case "dispatch":
      break;
  }

  if (parts.length === 0) {
    return { text: undefined, sourceAudit };
  }

  const joined = parts.join("\n\n");
  const needsWrapper = unitKind === "commander" || unitKind === "escort";
  const text = needsWrapper ? `## Custom Instructions\n\n${joined}` : joined;

  sourceAudit.push({
    origin: "fleet",
    field: "composed",
    hash: hashContent(text),
  });

  return { text, sourceAudit };
}

/**
 * Compose the pair of customInstructions texts for a gate escort launch.
 * Returns both the escort's text (for Escort process) and the ship's text (for restoring after Escort exits).
 */
export function composeForGate(ci?: CustomInstructions): {
  escortText: string | undefined;
  shipText: string | undefined;
  sourceAudit: SystemPromptSource[];
} {
  const sourceAudit: SystemPromptSource[] = [];

  const escortResult = compose({ unitKind: "escort", customInstructions: ci });
  const shipResult = compose({ unitKind: "ship", customInstructions: ci });

  sourceAudit.push(...escortResult.sourceAudit, ...shipResult.sourceAudit);

  return {
    escortText: escortResult.text,
    shipText: shipResult.text,
    sourceAudit,
  };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}
