import type { StreamMessage } from "@/types";

type SessionContext = "ship" | "command";

interface FilterRule {
  subtype: string;
  contexts: SessionContext[];
  render: true;
}

/**
 * Declarative rules for which system subtypes to render in each session context.
 * Adding a new system message type requires only a single row here.
 */
const MESSAGE_FILTER_RULES: FilterRule[] = [
  { subtype: "ship-status", contexts: ["ship", "command"], render: true },
  { subtype: "compact-status", contexts: ["ship", "command"], render: true },
  { subtype: "task-notification", contexts: ["ship", "command"], render: true },
  { subtype: "request-result", contexts: ["ship", "command"], render: true },
  { subtype: "gate-check-request", contexts: ["ship", "command"], render: true },
  { subtype: "pr-review-request", contexts: ["ship", "command"], render: true },
  { subtype: "rate-limit-status", contexts: ["ship", "command"], render: true },
  { subtype: "lookout-alert", contexts: ["command"], render: true },
  { subtype: "commander-status", contexts: ["command"], render: true },
  { subtype: "escort-log", contexts: ["ship", "command"], render: true },
  { subtype: "dispatch-log", contexts: ["ship", "command"], render: true },
];

const ruleMap = new Map(MESSAGE_FILTER_RULES.map((r) => [r.subtype, r]));

/**
 * Pre-filter messages that SessionMessage/ChatMessage would suppress (return null).
 * Removing them before groupToolMessages() prevents invisible messages
 * from breaking consecutive tool_use grouping.
 */
export function filterSessionMessages(
  msgs: StreamMessage[],
  context: SessionContext,
): StreamMessage[] {
  const isShip = context === "ship";
  return msgs.filter((msg) => {
    const isSystem = msg.type === "system";
    // Ship sessions never show User messages
    if (isShip && msg.type === "user") return false;
    // Escort log: suppress in non-Ship.
    // Check meta.category (not subtype) — Escort messages are type "assistant", not "system" (#729).
    if (msg.meta?.category === "escort-log" && !isShip) return false;
    // System messages: check against the declarative rule table
    if (isSystem) {
      const rule = ruleMap.get(msg.subtype ?? "");
      if (rule) return rule.contexts.includes(context);
      // Messages with meta.category (e.g. escort-log, dispatch-log) are handled
      // separately and should pass through.
      if (msg.meta?.category) return true;
      // Unrecognized system subtypes render as null in ChatMessage — filter out
      return false;
    }
    // Messages with no displayable content (ChatMessage L291 guard)
    if (!msg.content && msg.type !== "tool_use") return false;
    return true;
  });
}
