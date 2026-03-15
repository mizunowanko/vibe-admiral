import type { StreamMessage } from "./types.js";

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
