import { describe, expect, it } from "vitest";
import {
  parseStreamMessage,
  extractSessionId,
} from "../../stream-parser.js";

/**
 * Integration test: stream-parser after admiral-request removal
 *
 * After #459, admiral-request blocks are no longer extracted from stdout text.
 * Ship management operations use the HTTP REST API instead.
 *
 * These tests verify that:
 * - parseStreamMessage() continues to work correctly for all message types
 * - extractSessionId() works for init messages
 * - admiral-request blocks in text are NOT stripped (treated as regular text)
 */
describe("stream parser (post admiral-request removal)", () => {
  describe("parseStreamMessage", () => {
    it("parses assistant message with text", () => {
      const raw = {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "I'll launch a sortie now.",
            },
          ],
        },
      };

      const parsed = parseStreamMessage(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("assistant");
      expect(parsed!.content).toBe("I'll launch a sortie now.");
    });

    it("passes through text containing admiral-request blocks unchanged", () => {
      const text = `Launching sortie now.\n\n\`\`\`admiral-request\n{ "request": "sortie", "items": [{ "repo": "owner/repo", "issueNumber": 42 }] }\n\`\`\``;
      const raw = {
        type: "assistant",
        message: {
          content: [{ type: "text", text }],
        },
      };

      const parsed = parseStreamMessage(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("assistant");
      // After #459, admiral-request blocks are no longer stripped
      expect(parsed!.content).toContain("admiral-request");
    });

    it("parses tool_use messages", () => {
      const raw = {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-123",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
        },
      };

      const parsed = parseStreamMessage(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("tool_use");
      expect(parsed!.tool).toBe("Bash");
    });
  });

  describe("extractSessionId", () => {
    it("extracts session ID from init messages", () => {
      const raw = {
        type: "system",
        subtype: "init",
        session_id: "sess-123",
      };

      const sessionId = extractSessionId(raw);
      expect(sessionId).toBe("sess-123");
    });

    it("returns null for non-init messages", () => {
      const raw = {
        type: "assistant",
        message: { content: [] },
      };

      const sessionId = extractSessionId(raw);
      expect(sessionId).toBeNull();
    });
  });
});
