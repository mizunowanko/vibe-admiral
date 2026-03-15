import type { StreamMessage, BridgeAction } from "./types.js";

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
        return {
          type: "tool_use",
          tool: toolName,
          content: toolName,
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

    default:
      return null;
  }
}

const ACTION_BLOCK_RE = /```admiral-action\n([\s\S]*?)```/g;

/**
 * Extract BridgeAction objects from assistant text containing
 * ```admiral-action ... ``` fenced blocks.
 */
export function extractActions(text: string): BridgeAction[] {
  const actions: BridgeAction[] = [];
  let match: RegExpExecArray | null;
  while ((match = ACTION_BLOCK_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as BridgeAction;
      actions.push(parsed);
    } catch {
      // Malformed JSON — skip
    }
  }
  ACTION_BLOCK_RE.lastIndex = 0;
  return actions;
}

/**
 * Remove ```admiral-action ... ``` blocks from text for display purposes.
 */
export function stripActionBlocks(text: string): string {
  return text.replace(ACTION_BLOCK_RE, "").trim();
}
