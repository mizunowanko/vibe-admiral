import type {
  SystemMessageMeta,
  StreamMessageSubtype,
  LookoutAlertType,
  AlertSeverity,
} from "@/types";
import { cn } from "@/lib/utils";
import { gateTypeDisplayName } from "@/lib/ship-status";

const ALERT_TYPE_LABELS: Record<LookoutAlertType, string> = {
  "no-output-stall": "no output",
  "gate-wait-stall": "gate wait",
  "excessive-retries": "retried",
  "escort-death": "escort died",
};

const SEVERITY_BADGE: Record<AlertSeverity, { label: string; className: string }> = {
  critical: { label: "CRIT", className: "bg-red-500/20 text-red-300" },
  warning: { label: "WARN", className: "bg-orange-500/20 text-orange-300" },
  info: { label: "INFO", className: "bg-blue-500/20 text-blue-300" },
};

function lookoutLabel(meta: SystemMessageMeta): string {
  const issueRef = meta.issueNumber ? `#${meta.issueNumber}` : "";
  const alertLabel = meta.alertType
    ? ALERT_TYPE_LABELS[meta.alertType]
    : "alert";
  const detail = meta.branchName ? ` (${meta.branchName})` : "";
  return `${issueRef} Lookout: ${alertLabel}${detail}`;
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
  "gate-skip": {
    icon: "⏭",
    border: "border-green-500/30",
    bg: "bg-green-500/10",
    text: "text-green-300",
  },
  "pr-review-request": {
    icon: "📝",
    border: "border-sky-500/30",
    bg: "bg-sky-500/10",
    text: "text-sky-300",
  },
  "lookout-alert": {
    icon: "⚠️",
    border: "border-orange-500/30",
    bg: "bg-orange-500/10",
    text: "text-orange-300",
  },
  // subtypes not rendered by this component (use existing renderers)
  "task-notification": null,
  "ship-status": null,
  "compact-status": null,
  "commander-status": null,
  "request-result": null,
  "dispatch-log": null,
  "escort-log": null,
  "rate-limit-status": null,
  "heads-up": null,
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
      label = `${issueRef} ${gateTypeDisplayName(meta.gateType)}開始`;
      break;
    case "gate-skip":
      label = `${issueRef} Escort スキップ (qaRequired: false)`;
      break;
    case "pr-review-request":
      label = meta.prNumber
        ? `${issueRef} PR #${meta.prNumber} レビュー依頼`
        : `${issueRef} PR レビュー依頼`;
      break;
    case "lookout-alert":
      label = lookoutLabel(meta);
      break;
    default:
      return null;
  }

  const link = meta.prUrl ?? meta.url;
  const severityBadge = subtype === "lookout-alert" && meta.alertSeverity
    ? SEVERITY_BADGE[meta.alertSeverity]
    : null;

  // Override border color for critical lookout alerts
  const borderClass = subtype === "lookout-alert" && meta.alertSeverity === "critical"
    ? "border-red-500/30"
    : style.border;
  const bgClass = subtype === "lookout-alert" && meta.alertSeverity === "critical"
    ? "bg-red-500/10"
    : style.bg;

  return (
    <div className="flex w-full justify-start">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-mono",
          borderClass,
          bgClass,
          style.text,
        )}
      >
        <span>{style.icon}</span>
        {severityBadge && (
          <span className={cn("rounded px-1 py-0.5 text-[10px] font-bold leading-none", severityBadge.className)}>
            {severityBadge.label}
          </span>
        )}
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
