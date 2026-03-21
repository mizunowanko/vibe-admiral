import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChatMessage } from "./ChatMessage";
import type { ToolUseGroupItem } from "@/lib/group-tool-messages";

interface ToolUseGroupProps {
  group: ToolUseGroupItem;
  context?: "bridge" | "ship";
}

export function ToolUseGroup({ group, context }: ToolUseGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const toolUseCount = group.messages.filter((m) => m.type === "tool_use").length;

  return (
    <div>
      <div className="flex w-full justify-start">
        <button
          type="button"
          className={cn(
            "max-w-[90%] rounded border-l-2 border-muted-foreground/30 px-3 py-1.5 cursor-pointer select-none text-left",
            "hover:bg-muted/30 transition-colors",
          )}
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
            <span className="text-[10px]">{expanded ? "▼" : "▶"}</span>
            <span className="text-muted-foreground/70">
              {toolUseCount} tool uses
            </span>
          </div>
        </button>
      </div>
      {expanded && (
        <div className="space-y-1 mt-1 pl-2">
          {group.messages.map((msg, i) => (
            <ChatMessage key={msg.timestamp ?? i} message={msg} context={context} />
          ))}
        </div>
      )}
    </div>
  );
}
