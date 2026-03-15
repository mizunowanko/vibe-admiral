import type { StreamMessage, BridgeRequest } from "./types.js";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
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
        return {
          type: "tool_use",
          tool: toolName,
          content: toolInput
            ? JSON.stringify(toolInput, null, 2)
            : toolName,
          ...(toolInput ? { toolInput } : {}),
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
      return {
        type: "system",
        subtype,
        content: (raw.content as string) ?? subtype ?? "system",
      };
    }

    case "tool_result": {
      const content = raw.content as string | undefined;
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

function validateRequest(obj: unknown): BridgeRequest | null {
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

    default:
      return null;
  }
}

/**
 * Extract BridgeRequest objects from ```admiral-request ... ``` fenced blocks.
 */
export function extractRequests(text: string): BridgeRequest[] {
  const requests: BridgeRequest[] = [];
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

/**
 * Remove ```admiral-request ... ``` blocks from text for display purposes.
 */
export function stripRequestBlocks(text: string): string {
  return text.replace(REQUEST_BLOCK_RE, "").trim();
}
