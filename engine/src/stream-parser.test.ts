import { describe, it, expect } from "vitest";
import { parseStreamMessage } from "./stream-parser.js";

describe("parseStreamMessage", () => {
  // === tool_result ===

  describe("tool_result", () => {
    it("returns content when content is a string", () => {
      const result = parseStreamMessage({
        type: "tool_result",
        content: "hello world",
      });
      expect(result).toEqual({ type: "tool_result", content: "hello world" });
    });

    it("extracts text from ContentBlock array", () => {
      const result = parseStreamMessage({
        type: "tool_result",
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      });
      expect(result).toEqual({
        type: "tool_result",
        content: "line 1\nline 2",
      });
    });

    it("returns null when ContentBlock array has no text blocks (image only)", () => {
      const result = parseStreamMessage({
        type: "tool_result",
        content: [
          { type: "image", source: { type: "base64", data: "..." } },
        ],
      });
      expect(result).toBeNull();
    });

    it("returns null when content is an empty array", () => {
      const result = parseStreamMessage({
        type: "tool_result",
        content: [],
      });
      expect(result).toBeNull();
    });

    it("returns null when content is undefined", () => {
      const result = parseStreamMessage({
        type: "tool_result",
      });
      expect(result).toBeNull();
    });

    it("returns null when content is null", () => {
      const result = parseStreamMessage({
        type: "tool_result",
        content: null,
      });
      expect(result).toBeNull();
    });

    it("skips text blocks with no text property", () => {
      const result = parseStreamMessage({
        type: "tool_result",
        content: [
          { type: "text" },
          { type: "text", text: "valid" },
        ],
      });
      expect(result).toEqual({ type: "tool_result", content: "valid" });
    });
  });

  // === assistant ===

  describe("assistant", () => {
    it("returns text content from text blocks", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello from Claude" }],
        },
      });
      expect(result).toEqual({
        type: "assistant",
        content: "Hello from Claude",
      });
    });

    it("joins multiple text blocks with newline", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First paragraph" },
            { type: "text", text: "Second paragraph" },
          ],
        },
      });
      expect(result).toEqual({
        type: "assistant",
        content: "First paragraph\nSecond paragraph",
      });
    });

    it("returns tool_use when only tool_use blocks are present", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_123",
              name: "Read",
              input: { file_path: "/tmp/test.ts" },
            },
          ],
        },
      });
      expect(result).toEqual({
        type: "tool_use",
        tool: "Read",
        content: JSON.stringify({ file_path: "/tmp/test.ts" }, null, 2),
        toolInput: { file_path: "/tmp/test.ts" },
        toolUseId: "tu_123",
      });
    });

    it("prefers text over tool_use when both are present", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me read the file" },
            {
              type: "tool_use",
              id: "tu_456",
              name: "Read",
              input: { file_path: "/tmp/test.ts" },
            },
          ],
        },
      });
      expect(result).toEqual({
        type: "assistant",
        content: "Let me read the file",
      });
    });

    it("uses tool name as content when tool has no input", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_789", name: "ListFiles" },
          ],
        },
      });
      expect(result).toEqual({
        type: "tool_use",
        tool: "ListFiles",
        content: "ListFiles",
        toolUseId: "tu_789",
      });
    });

    it("returns null when message has empty content blocks", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: { content: [] },
      });
      expect(result).toBeNull();
    });

    it("returns null when message is undefined", () => {
      const result = parseStreamMessage({ type: "assistant" });
      expect(result).toBeNull();
    });

    it("returns null when message.content is undefined", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: {},
      });
      expect(result).toBeNull();
    });

    it("defaults tool name to 'tool' when name is missing", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", input: { key: "value" } },
          ],
        },
      });
      expect(result).toEqual({
        type: "tool_use",
        tool: "tool",
        content: JSON.stringify({ key: "value" }, null, 2),
        toolInput: { key: "value" },
      });
    });

    it("omits toolUseId when id is missing", () => {
      const result = parseStreamMessage({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      });
      expect(result).not.toHaveProperty("toolUseId");
    });
  });

  // === system ===

  describe("system", () => {
    it("returns null for init subtype", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "init",
      });
      expect(result).toBeNull();
    });

    it("returns null for hook subtypes", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "hook:preToolUse",
      });
      expect(result).toBeNull();
    });

    it("returns compact-status for compacting status", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "status",
        status: "compacting",
      });
      expect(result).toEqual({
        type: "system",
        subtype: "compact-status",
        content: "Compacting context...",
      });
    });

    it("returns compact-status for null status (compact ended)", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "status",
        status: null,
      });
      expect(result).toEqual({
        type: "system",
        subtype: "compact-status",
        content: "Context compaction complete",
      });
    });

    it("returns compact-status for undefined status", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "status",
      });
      expect(result).toEqual({
        type: "system",
        subtype: "compact-status",
        content: "Context compaction complete",
      });
    });

    it("falls through to generic handler for non-compact status", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "status",
        status: "some-other-status",
        content: "Some status info",
      });
      expect(result).toEqual({
        type: "system",
        subtype: "status",
        content: "Some status info",
      });
    });

    it("handles compact_boundary with metadata", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 150000 },
      });
      expect(result).toEqual({
        type: "system",
        subtype: "compact-status",
        content: "Context compacted (manual, 150,000 tokens before)",
      });
    });

    it("handles compact_boundary with auto trigger and no pre_tokens", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {},
      });
      expect(result).toEqual({
        type: "system",
        subtype: "compact-status",
        content: "Context compacted (auto)",
      });
    });

    it("handles compact_boundary with no metadata", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "compact_boundary",
      });
      expect(result).toEqual({
        type: "system",
        subtype: "compact-status",
        content: "Context compacted (auto)",
      });
    });

    it("returns generic system message with content", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "warning",
        content: "Rate limit approaching",
      });
      expect(result).toEqual({
        type: "system",
        subtype: "warning",
        content: "Rate limit approaching",
      });
    });

    it("falls back to subtype as content when content is missing", () => {
      const result = parseStreamMessage({
        type: "system",
        subtype: "unknown-subtype",
      });
      expect(result).toEqual({
        type: "system",
        subtype: "unknown-subtype",
        content: "unknown-subtype",
      });
    });

    it("falls back to 'system' when both content and subtype are missing", () => {
      const result = parseStreamMessage({
        type: "system",
      });
      expect(result).toEqual({
        type: "system",
        subtype: undefined,
        content: "system",
      });
    });
  });

  // === result ===

  describe("result", () => {
    it("returns result content", () => {
      const result = parseStreamMessage({
        type: "result",
        result: "Task completed successfully",
      });
      expect(result).toEqual({
        type: "result",
        content: "Task completed successfully",
      });
    });

    it("returns null for empty result", () => {
      const result = parseStreamMessage({
        type: "result",
        result: "",
      });
      expect(result).toBeNull();
    });

    it("returns null for undefined result", () => {
      const result = parseStreamMessage({
        type: "result",
      });
      expect(result).toBeNull();
    });
  });

  // === default (unknown types) ===

  describe("default", () => {
    it("returns null for unknown message type", () => {
      const result = parseStreamMessage({
        type: "unknown_type",
        data: "something",
      });
      expect(result).toBeNull();
    });

    it("returns null when type is undefined", () => {
      const result = parseStreamMessage({
        data: "no type field",
      });
      expect(result).toBeNull();
    });
  });
});
