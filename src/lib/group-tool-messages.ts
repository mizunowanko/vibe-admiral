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
 * - `assistant` messages between tool calls are tentatively included in the
 *   group (Claude CLI emits brief text like "Let me check…" before each
 *   tool_use). If the group ends with trailing assistant messages (not
 *   followed by more tool calls), they are popped out and rendered normally.
 * - Other message types (`user`, `system`, etc.) break the current group.
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

    // Trim trailing non-tool messages (assistant text not followed by more tools)
    const trailing: StreamMessage[] = [];
    while (currentGroup.length > 0) {
      const last = currentGroup[currentGroup.length - 1]!;
      if (last.type === "tool_use" || last.type === "tool_result") break;
      trailing.unshift(currentGroup.pop()!);
    }

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

    // Emit trailing messages that weren't part of the tool group
    for (const m of trailing) {
      result.push(m as DisplayItem);
    }
  }

  for (const msg of msgs) {
    if (msg.type === "tool_use" || msg.type === "tool_result") {
      currentGroup.push(msg);
    } else if (currentGroup.length > 0 && msg.type === "assistant") {
      // Assistant text between tool calls — tentatively include.
      // Trimmed on flush if not followed by more tool calls.
      currentGroup.push(msg);
    } else {
      flushGroup();
      result.push(msg as DisplayItem);
    }
  }

  flushGroup();
  return result;
}
