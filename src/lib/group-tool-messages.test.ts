import { describe, it, expect } from "vitest";
import { groupToolMessages, isToolGroup, type DisplayItem, type ToolUseGroupItem } from "./group-tool-messages";
import type { StreamMessage } from "@/types";

function msg(type: StreamMessage["type"], extra?: Partial<StreamMessage>): StreamMessage {
  return { type, content: `${type} content`, timestamp: Date.now(), ...extra };
}

describe("groupToolMessages", () => {
  it("returns empty array for empty input", () => {
    expect(groupToolMessages([])).toEqual([]);
  });

  it("keeps a single tool_use inline (no group wrapper)", () => {
    const input = [msg("tool_use", { tool: "Bash" })];
    const result = groupToolMessages(input);
    expect(result).toHaveLength(1);
    expect(isToolGroup(result[0]!)).toBe(false);
    expect((result[0] as StreamMessage).type).toBe("tool_use");
  });

  it("keeps a single tool_use + tool_result inline", () => {
    const input = [
      msg("tool_use", { tool: "Read" }),
      msg("tool_result"),
    ];
    const result = groupToolMessages(input);
    expect(result).toHaveLength(2);
    expect(result.every((r) => !isToolGroup(r))).toBe(true);
  });

  it("groups multiple consecutive tool_use messages", () => {
    const input = [
      msg("tool_use", { tool: "Bash" }),
      msg("tool_result"),
      msg("tool_use", { tool: "Read" }),
      msg("tool_result"),
      msg("tool_use", { tool: "Grep" }),
      msg("tool_result"),
    ];
    const result = groupToolMessages(input);
    expect(result).toHaveLength(1);
    expect(isToolGroup(result[0]!)).toBe(true);
    const group = result[0] as ToolUseGroupItem;
    expect(group.messages).toHaveLength(6);
  });

  it("splits groups when a non-tool message intervenes", () => {
    const input = [
      msg("tool_use", { tool: "Bash" }),
      msg("tool_result"),
      msg("tool_use", { tool: "Read" }),
      msg("tool_result"),
      msg("assistant"),
      msg("tool_use", { tool: "Grep" }),
      msg("tool_result"),
      msg("tool_use", { tool: "Glob" }),
      msg("tool_result"),
    ];
    const result = groupToolMessages(input);
    // Group of 2 tool_use, then assistant, then group of 2 tool_use
    expect(result).toHaveLength(3);
    expect(isToolGroup(result[0]!)).toBe(true);
    expect(isToolGroup(result[1]!)).toBe(false);
    expect((result[1] as StreamMessage).type).toBe("assistant");
    expect(isToolGroup(result[2]!)).toBe(true);
  });

  it("handles mixed message types correctly", () => {
    const input = [
      msg("assistant"),
      msg("tool_use", { tool: "Bash" }),
      msg("tool_result"),
      msg("assistant"),
      msg("user"),
    ];
    const result = groupToolMessages(input);
    // Single tool_use + tool_result stays inline (no grouping)
    expect(result).toHaveLength(5);
    expect((result[0] as StreamMessage).type).toBe("assistant");
    expect((result[1] as StreamMessage).type).toBe("tool_use");
    expect((result[2] as StreamMessage).type).toBe("tool_result");
    expect((result[3] as StreamMessage).type).toBe("assistant");
    expect((result[4] as StreamMessage).type).toBe("user");
  });

  it("includes tool_result in groups", () => {
    const input = [
      msg("tool_use", { tool: "A" }),
      msg("tool_result"),
      msg("tool_use", { tool: "B" }),
      msg("tool_result"),
    ];
    const result = groupToolMessages(input);
    expect(result).toHaveLength(1);
    const group = result[0] as ToolUseGroupItem;
    expect(group.messages.filter((m) => m.type === "tool_use")).toHaveLength(2);
    expect(group.messages.filter((m) => m.type === "tool_result")).toHaveLength(2);
  });

  it("preserves timestamp from first message in group", () => {
    const ts = 1234567890;
    const input = [
      msg("tool_use", { tool: "A", timestamp: ts }),
      msg("tool_use", { tool: "B", timestamp: ts + 1000 }),
    ];
    const result = groupToolMessages(input);
    expect(isToolGroup(result[0]!)).toBe(true);
    expect((result[0] as ToolUseGroupItem).timestamp).toBe(ts);
  });

  it("flushes trailing tool group at end of array", () => {
    const input = [
      msg("assistant"),
      msg("tool_use", { tool: "A" }),
      msg("tool_use", { tool: "B" }),
      msg("tool_use", { tool: "C" }),
    ];
    const result = groupToolMessages(input);
    expect(result).toHaveLength(2);
    expect((result[0] as StreamMessage).type).toBe("assistant");
    expect(isToolGroup(result[1]!)).toBe(true);
    expect((result[1] as ToolUseGroupItem).messages).toHaveLength(3);
  });

  it("does not include assistant text inside tool_use groups (#724)", () => {
    const input = [
      msg("tool_use", { tool: "Bash" }),
      msg("tool_result"),
      msg("assistant"),
      msg("tool_use", { tool: "Read" }),
      msg("tool_result"),
      msg("tool_use", { tool: "Grep" }),
      msg("tool_result"),
    ];
    const result = groupToolMessages(input);
    // tool_use(1) inline, assistant independent, tool_use(2) group
    expect(result).toHaveLength(4);
    expect(isToolGroup(result[0]!)).toBe(false);
    expect((result[0] as StreamMessage).type).toBe("tool_use");
    expect((result[1] as StreamMessage).type).toBe("tool_result");
    expect((result[2] as StreamMessage).type).toBe("assistant");
    expect(isToolGroup(result[3]!)).toBe(true);
    expect((result[3] as ToolUseGroupItem).messages).toHaveLength(4);
    // No assistant messages inside the group
    expect(
      (result[3] as ToolUseGroupItem).messages.every(
        (m) => m.type === "tool_use" || m.type === "tool_result",
      ),
    ).toBe(true);
  });

  it("does not group non-tool messages", () => {
    const input = [
      msg("assistant"),
      msg("user"),
      msg("system"),
    ];
    const result = groupToolMessages(input);
    expect(result).toHaveLength(3);
    expect(result.every((r) => !isToolGroup(r))).toBe(true);
  });
});

describe("isToolGroup", () => {
  it("returns true for ToolUseGroupItem", () => {
    const item: ToolUseGroupItem = { kind: "tool-group", messages: [] };
    expect(isToolGroup(item)).toBe(true);
  });

  it("returns false for StreamMessage", () => {
    expect(isToolGroup(msg("assistant") as DisplayItem)).toBe(false);
  });
});
