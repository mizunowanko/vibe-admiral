import { useState, useMemo, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ImageAttachment, StreamMessage } from "@/types";
import { cn } from "@/lib/utils";
import { getStatusColor } from "@/lib/ship-status";
import { formatTime } from "@/lib/format-time";

/** Convert base64 ImageAttachments to object URLs, revoking on cleanup. */
function useImageObjectUrls(images: ImageAttachment[] | undefined): string[] {
  const urls = useMemo(() => {
    if (!images || images.length === 0) return [];
    return images.map((img) => {
      const binary = atob(img.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: img.mediaType });
      return URL.createObjectURL(blob);
    });
  }, [images]);

  useEffect(() => {
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [urls]);

  return urls;
}

const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

interface ChatMessageProps {
  message: StreamMessage;
  repeatCount?: number;
  /** Rendering context: "ship" enables LINE-style layout (assistant right-aligned). */
  context?: "command" | "bridge" | "ship";
}

export function ChatMessage({ message, repeatCount, context }: ChatMessageProps) {
  const [toolExpanded, setToolExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const imageUrls = useImageObjectUrls(message.images);

  const isUser = message.type === "user";
  const isError = message.type === "error";
  const isSystem = message.type === "system";

  // Tool use — collapsible by default
  if (message.type === "tool_use") {
    const hasContent = Boolean(message.toolInput) ||
      (message.content && message.content !== message.tool);
    return (
      <div className="flex w-full justify-start">
        <button
          type="button"
          className={cn(
            "max-w-[90%] rounded border-l-2 border-muted-foreground/30 px-3 py-1.5 cursor-pointer select-none text-left",
            "hover:bg-muted/30 transition-colors",
          )}
          onClick={() => setToolExpanded(!toolExpanded)}
        >
          <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
            <span className="text-[10px]">{toolExpanded ? "▼" : "▶"}</span>
            <span className="text-muted-foreground/70">
              [{message.tool}]
            </span>
          </div>
          {toolExpanded && hasContent && (
            <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground/80 mt-1.5 font-mono leading-relaxed">
              {message.content}
            </pre>
          )}
        </button>
      </div>
    );
  }

  // Tool result — collapsible
  if (message.type === "tool_result") {
    return (
      <div className="flex w-full justify-start">
        <button
          type="button"
          className={cn(
            "max-w-[90%] rounded border-l-2 border-emerald-500/30 px-3 py-1.5 cursor-pointer select-none text-left",
            "hover:bg-muted/30 transition-colors",
          )}
          onClick={() => setResultExpanded(!resultExpanded)}
        >
          <div className="flex items-center gap-1.5 text-xs font-mono text-emerald-400/70">
            <span className="text-[10px]">{resultExpanded ? "▼" : "▶"}</span>
            <span>result</span>
          </div>
          {resultExpanded && message.content && (
            <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground/80 mt-1.5 font-mono leading-relaxed max-h-60 overflow-y-auto">
              {message.content}
            </pre>
          )}
        </button>
      </div>
    );
  }

  // Ship status inline badge
  if (isSystem && message.subtype === "ship-status") {
    return (
      <div className="flex w-full justify-start">
        <div
          className={cn(
            "flex items-center gap-1.5 rounded px-2 py-1 text-xs font-mono",
            "bg-muted/50 border border-border/50",
          )}
        >
          <span className="text-muted-foreground">⚓</span>
          <span className={getStatusColor(message.content ?? "")}>
            {message.content}
          </span>
          {repeatCount && repeatCount > 1 && (
            <span className="text-muted-foreground/50 text-[10px]">
              x{repeatCount}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Compact status — centered purple badge
  if (isSystem && message.subtype === "compact-status") {
    const isCompacting = message.content?.includes("Compacting context");
    return (
      <div className="flex w-full justify-center">
        <div
          className={cn(
            "flex items-center gap-1.5 rounded px-3 py-1 text-xs font-mono",
            "bg-purple-500/10 border border-purple-500/30 text-purple-400",
          )}
        >
          {isCompacting && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          )}
          <span>{message.content}</span>
        </div>
      </div>
    );
  }

  // Task notification — compact muted pill
  if (isSystem && message.subtype === "task-notification") {
    return (
      <div className="flex w-full justify-start">
        <div
          className={cn(
            "flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-mono",
            "border-slate-500/30 bg-slate-500/10 text-slate-400",
          )}
        >
          <span>📋</span>
          <span>{message.content}</span>
        </div>
      </div>
    );
  }

  // Request result — collapsible when long
  if (isSystem && message.subtype === "request-result") {
    const content = message.content ?? "";
    const lines = content.split("\n");
    const isLong = lines.length > 3;
    const displayContent = !isLong || resultExpanded
      ? content
      : lines.slice(0, 2).join("\n") + "\n…";

    return (
      <div className="flex w-full justify-start">
        <div className="max-w-[90%] rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-xs font-mono text-primary/70 block mb-1">
            [Engine]
          </span>
          <pre className="whitespace-pre-wrap break-words text-card-foreground font-mono text-xs">
            {displayContent}
          </pre>
          {isLong && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground mt-1 underline underline-offset-2"
              onClick={() => setResultExpanded(!resultExpanded)}
            >
              {resultExpanded ? "show less" : `show more (${lines.length - 2} more lines)`}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Dispatch log — sub-agent messages routed to Ship
  if (isSystem && message.meta?.category === "dispatch-log") {
    return (
      <div className="flex w-full justify-start">
        <div
          className={cn(
            "max-w-[90%] rounded-lg px-3 py-2 text-sm border",
            "border-amber-500/20 bg-amber-500/5",
          )}
        >
          <span
            className="text-xs font-mono block mb-1 text-amber-400/70"
          >
            [Dispatch]
          </span>
          <div className="bridge-markdown break-words text-card-foreground">
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              components={MARKDOWN_COMPONENTS}
              disallowedElements={["img"]}
              unwrapDisallowed
            >
              {message.content ?? ""}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  // Fall-through for unhandled system subtypes — return null so caller can handle
  if (isSystem) {
    return null;
  }

  const content = message.content ?? "";
  // In Ship context, assistant messages are right-aligned (LINE-style: Ship speaks on the right)
  const isShipAssistant = context === "ship" && message.type === "assistant";
  const isRightAligned = isUser || isShipAssistant;

  return (
    <div
      className={cn(
        "flex w-full",
        isRightAligned ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-sm",
          isUser || isShipAssistant
            ? "bg-primary text-primary-foreground"
            : isError
              ? "bg-destructive/10 text-destructive-foreground border border-destructive/20"
              : "bg-card text-card-foreground",
        )}
      >
        {message.tool && (
          <span className="text-xs font-mono text-muted-foreground block mb-1">
            [{message.tool}]
          </span>
        )}
        {isUser && imageUrls.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mb-1.5">
            {imageUrls.map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`Attachment ${i + 1}`}
                className="h-24 max-w-48 rounded border border-primary-foreground/20 object-cover"
              />
            ))}
          </div>
        )}
        {isUser && !message.images && message.imageCount && message.imageCount > 0 && (
          <span className="text-xs text-primary-foreground/60 block mb-1">
            {message.imageCount} image{message.imageCount > 1 ? "s" : ""} attached
          </span>
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{content}</p>
        ) : (
          <div className="bridge-markdown break-words">
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              components={MARKDOWN_COMPONENTS}
              disallowedElements={["img"]}
              unwrapDisallowed
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
        {message.timestamp && (
          <span className={cn(
            "block text-[10px] mt-1 text-right",
            isRightAligned ? "text-primary-foreground/60" : "text-slate-400",
          )}>
            {formatTime(message.timestamp)}
          </span>
        )}
      </div>
    </div>
  );
}
