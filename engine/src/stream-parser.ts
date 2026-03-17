import type { StreamMessage, StreamMessageSubtype, BridgeRequest, ShipRequest, AdmiralRequest, ShipStatus, GateTransition } from "./types.js";
import { GATE_TRANSITIONS } from "./gate-config.js";

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Extract sessionId from a raw init message.
 * Returns the sessionId string if this is an init message, null otherwise.
 * Must be called BEFORE parseStreamMessage (which drops init messages).
 */
export function extractSessionId(
  raw: Record<string, unknown>,
): string | null {
  if (raw.type !== "system") return null;
  if (raw.subtype !== "init") return null;
  const sessionId = raw.session_id as string | undefined;
  return sessionId ?? null;
}

/**
 * Transform raw Claude CLI stream-json output into a StreamMessage
 * that the frontend can display.
 *
 * Returns null for messages that should be silently dropped (e.g. hooks, init).
 */
export function parseStreamMessage(
  raw: Record<string, unknown>,
): StreamMessage | null {
  const type = raw.type as string | undefined;

  switch (type) {
    case "assistant": {
      const msg = raw.message as
        | { content?: ContentBlock[] }
        | undefined;
      const blocks = msg?.content ?? [];

      // Extract text blocks
      const texts = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string);

      // Extract tool_use blocks
      const toolUses = blocks.filter((b) => b.type === "tool_use");

      if (texts.length > 0) {
        return {
          type: "assistant",
          content: texts.join("\n"),
        };
      }

      if (toolUses.length > 0) {
        const toolName = toolUses[0]?.name ?? "tool";
        const toolInput = toolUses[0]?.input;
        const toolUseId = toolUses[0]?.id;
        return {
          type: "tool_use",
          tool: toolName,
          content: toolInput
            ? JSON.stringify(toolInput, null, 2)
            : toolName,
          ...(toolInput ? { toolInput } : {}),
          ...(toolUseId ? { toolUseId } : {}),
        };
      }

      // Assistant message with no text and no tool_use — skip
      return null;
    }

    case "result": {
      const result = raw.result as string | undefined;
      if (!result) return null;
      return {
        type: "result",
        content: result,
      };
    }

    case "system": {
      const subtype = raw.subtype as string | undefined;
      // Skip hooks and init — not useful for the user
      if (subtype === "init" || subtype?.startsWith("hook")) {
        return null;
      }
      // Compact status: { type: "system", subtype: "status", status: "compacting" | null }
      if (subtype === "status") {
        const status = raw.status as string | null | undefined;
        if (status === "compacting" || status === null || status === undefined) {
          return {
            type: "system",
            subtype: "compact-status",
            content: status === "compacting" ? "Compacting context..." : "Context compaction complete",
          };
        }
        // Non-compact status messages — fall through to generic handler
      }
      // Compact boundary: { type: "system", subtype: "compact_boundary", compact_metadata: {...} }
      if (subtype === "compact_boundary") {
        const metadata = raw.compact_metadata as { trigger?: string; pre_tokens?: number } | undefined;
        const trigger = metadata?.trigger ?? "auto";
        const preTokens = metadata?.pre_tokens;
        const detail = preTokens
          ? `Context compacted (${trigger}, ${preTokens.toLocaleString()} tokens before)`
          : `Context compacted (${trigger})`;
        return {
          type: "system",
          subtype: "compact-status",
          content: detail,
        };
      }
      return {
        type: "system",
        subtype: subtype as StreamMessageSubtype | undefined,
        content: (raw.content as string) ?? subtype ?? "system",
      };
    }

    case "tool_result": {
      const rawContent = raw.content;
      let content: string | undefined;
      if (typeof rawContent === "string") {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        content = (rawContent as ContentBlock[])
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text as string)
          .join("\n");
      }
      if (!content) return null;
      return {
        type: "tool_result",
        content,
      };
    }

    default:
      return null;
  }
}

// === admiral-request protocol ===

const REQUEST_BLOCK_RE = /```admiral-request\n([\s\S]*?)```/g;
const REPO_PATTERN_REQ = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/** Valid statuses that Ship can request via status-transition. */
const TRANSITION_TARGETS: ReadonlySet<ShipStatus> = new Set([
  "investigating",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "acceptance-test",
  "merging",
  "done",
]);

function validateRequest(obj: unknown): AdmiralRequest | null {
  if (typeof obj !== "object" || obj === null) return null;
  const r = obj as Record<string, unknown>;
  const req = r.request;
  if (typeof req !== "string") return null;

  switch (req) {
    case "ship-status":
      return { request: "ship-status" };

    case "ship-stop":
      if (typeof r.shipId !== "string" || !r.shipId) return null;
      return { request: "ship-stop", shipId: r.shipId };

    case "sortie": {
      if (!Array.isArray(r.items) || r.items.length === 0) return null;
      const items: Array<{ repo: string; issueNumber: number; skill?: string }> = [];
      for (const item of r.items) {
        if (typeof item !== "object" || item === null) return null;
        const it = item as Record<string, unknown>;
        if (typeof it.repo !== "string" || !REPO_PATTERN_REQ.test(it.repo)) return null;
        if (typeof it.issueNumber !== "number" || !Number.isInteger(it.issueNumber) || it.issueNumber <= 0) return null;
        const entry: { repo: string; issueNumber: number; skill?: string } = {
          repo: it.repo,
          issueNumber: it.issueNumber,
        };
        if (typeof it.skill === "string") entry.skill = it.skill;
        items.push(entry);
      }
      return { request: "sortie", items };
    }

    case "pr-review-result": {
      if (typeof r.shipId !== "string" || !r.shipId) return null;
      if (typeof r.prNumber !== "number" || !Number.isInteger(r.prNumber) || r.prNumber <= 0) return null;
      if (r.verdict !== "approve" && r.verdict !== "request-changes") return null;
      const result: { request: "pr-review-result"; shipId: string; prNumber: number; verdict: "approve" | "request-changes"; comments?: string } = {
        request: "pr-review-result",
        shipId: r.shipId,
        prNumber: r.prNumber,
        verdict: r.verdict,
      };
      if (typeof r.comments === "string") result.comments = r.comments;
      return result;
    }

    case "gate-result": {
      if (typeof r.shipId !== "string" || !r.shipId) return null;
      if (typeof r.transition !== "string" || !GATE_TRANSITIONS.includes(r.transition as GateTransition)) return null;
      if (r.verdict !== "approve" && r.verdict !== "reject") return null;
      const gateResult: { request: "gate-result"; shipId: string; transition: GateTransition; verdict: "approve" | "reject"; feedback?: string; issueNumber?: number } = {
        request: "gate-result",
        shipId: r.shipId,
        transition: r.transition as GateTransition,
        verdict: r.verdict,
      };
      if (typeof r.feedback === "string") gateResult.feedback = r.feedback;
      if (typeof r.issueNumber === "number") gateResult.issueNumber = r.issueNumber;
      return gateResult;
    }

    case "status-transition": {
      const status = r.status as string | undefined;
      if (typeof status !== "string" || !TRANSITION_TARGETS.has(status as ShipStatus)) return null;
      const transition: { request: "status-transition"; status: ShipStatus; planCommentUrl?: string } = {
        request: "status-transition",
        status: status as ShipStatus,
      };
      if (typeof r.planCommentUrl === "string") transition.planCommentUrl = r.planCommentUrl;
      return transition;
    }

    case "nothing-to-do": {
      const reason = r.reason as string | undefined;
      if (typeof reason !== "string" || !reason) return null;
      return { request: "nothing-to-do", reason };
    }

    default:
      return null;
  }
}

/**
 * Extract AdmiralRequest objects from ```admiral-request ... ``` fenced blocks.
 * Returns both BridgeRequest and ShipRequest types — callers must filter by source.
 */
export function extractRequests(text: string): AdmiralRequest[] {
  const requests: AdmiralRequest[] = [];
  let match: RegExpExecArray | null;
  while ((match = REQUEST_BLOCK_RE.exec(text)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1]!);
      const validated = validateRequest(parsed);
      if (validated) requests.push(validated);
    } catch {
      console.warn("[stream-parser] Failed to parse admiral-request JSON");
    }
  }
  REQUEST_BLOCK_RE.lastIndex = 0;
  return requests;
}

/** Type guard: check if a request is a Bridge-only request. */
export function isBridgeRequest(req: AdmiralRequest): req is BridgeRequest {
  return req.request !== "status-transition" && req.request !== "nothing-to-do";
}

/** Type guard: check if a request is a Ship request. */
export function isShipRequest(req: AdmiralRequest): req is ShipRequest {
  return req.request === "status-transition" || req.request === "nothing-to-do";
}

/**
 * Remove ```admiral-request ... ``` blocks from text for display purposes.
 */
export function stripRequestBlocks(text: string): string {
  return text.replace(REQUEST_BLOCK_RE, "").trim();
}
