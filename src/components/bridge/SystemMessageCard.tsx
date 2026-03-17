import type { SystemMessageMeta, StreamMessageSubtype } from "@/types";
import { cn } from "@/lib/utils";

const GATE_TYPE_LABELS: Record<string, string> = {
  "plan-review": "計画レビュー",
  "code-review": "コードレビュー",
  playwright: "QA テスト",
  human: "人間承認",
};

function gateLabel(gateType?: string): string {
  return gateType ? (GATE_TYPE_LABELS[gateType] ?? gateType) : "Gate";
}

const STYLE: Record<
  StreamMessageSubtype,
  { icon: string; border: string; bg: string; text: string } | null
> = {
  "gate-check-request": {
    icon: "🚪",
    border: "border-indigo-500/30",
    bg: "bg-indigo-500/10",
    text: "text-indigo-300",
  },
  "pr-review-request": {
    icon: "📝",
    border: "border-sky-500/30",
    bg: "bg-sky-500/10",
    text: "text-sky-300",
  },
  "acceptance-test": {
    icon: "🧪",
    border: "border-amber-500/30",
    bg: "bg-amber-500/10",
    text: "text-amber-300",
  },
  "ship-status": {
    icon: "⚓",
    border: "border-border/50",
    bg: "bg-muted/50",
    text: "text-muted-foreground",
  },
  // subtypes not rendered by this component
  "compact-status": null,
  "bridge-status": null,
  "request-result": null,
};

interface SystemMessageCardProps {
  subtype: StreamMessageSubtype;
  meta: SystemMessageMeta;
}

export function SystemMessageCard({ subtype, meta }: SystemMessageCardProps) {
  const style = STYLE[subtype];
  if (!style) return null;

  const issueRef = meta.issueNumber ? `#${meta.issueNumber}` : "";

  let label: string;
  switch (subtype) {
    case "gate-check-request":
      label = `${issueRef} ${gateLabel(meta.gateType)}開始`;
      break;
    case "pr-review-request":
      label = meta.prNumber
        ? `${issueRef} PR #${meta.prNumber} レビュー依頼`
        : `${issueRef} PR レビュー依頼`;
      break;
    case "acceptance-test":
      label = `${issueRef} 受け入れテスト依頼`;
      break;
    case "ship-status":
      label = issueRef;
      break;
    default:
      return null;
  }

  const link =
    meta.prUrl ??
    (meta.issueNumber
      ? undefined
      : undefined);

  return (
    <div className="flex w-full justify-start">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-mono",
          style.border,
          style.bg,
          style.text,
        )}
      >
        <span>{style.icon}</span>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline underline-offset-2"
          >
            {label}
          </a>
        ) : (
          <span>{label}</span>
        )}
      </div>
    </div>
  );
}
