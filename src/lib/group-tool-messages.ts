import type { StreamMessage } from "@/types";

export interface ToolUseGroupItem {
  kind: "tool-group";
  messages: StreamMessage[];
  timestamp?: number;
}

export type DisplayItem = (StreamMessage & { repeatCount?: number }) | ToolUseGroupItem;

export function isToolGroup(item: DisplayItem): item is ToolUseGroupItem {
  return "kind" in item && item.kind === "tool-group";
}

/**
 * Group consecutive tool_use / tool_result messages into collapsible groups.
 *
 * Rules:
 * - Consecutive `tool_use` and `tool_result` messages form a group.
 * - `assistant` messages always break the current group and render independently.
 *   They must never be hidden inside a collapsed tool_use fold.
 * - Other message types (`user`, `system`, etc.) also break the current group.
 * - Groups with only 1 tool_use (+ optional tool_result) are kept inline
 *   (not wrapped in a group) so they render as before.
 */
export function groupToolMessages<T extends StreamMessage & { repeatCount?: number }>(
  msgs: T[],
): DisplayItem[] {
  const result: DisplayItem[] = [];
  let currentGroup: StreamMessage[] = [];

  function flushGroup() {
    if (currentGroup.length === 0) return;

    const toolUseCount = currentGroup.filter((m) => m.type === "tool_use").length;
    if (toolUseCount <= 1) {
      // Single tool_use (+ optional result) — keep inline
      for (const m of currentGroup) {
        result.push(m as DisplayItem);
      }
    } else {
      result.push({
        kind: "tool-group",
        messages: currentGroup,
        timestamp: currentGroup[0]?.timestamp,
      });
    }
    currentGroup = [];
  }

  for (const msg of msgs) {
    if (msg.type === "tool_use" || msg.type === "tool_result") {
      currentGroup.push(msg);
    } else {
      flushGroup();
      result.push(msg as DisplayItem);
    }
  }

  flushGroup();
  return result;
}
