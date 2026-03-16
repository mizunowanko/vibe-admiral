import { useState } from "react";
import type { Ship } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useShipStore } from "@/stores/shipStore";
import { isSafeUrl } from "@/lib/utils";
import { ExternalLink, Check, X, Loader2 } from "lucide-react";

interface AcceptanceTestBannerProps {
  ship: Ship;
}

export function AcceptanceTestBanner({ ship }: AcceptanceTestBannerProps) {
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const acceptTest = useShipStore((s) => s.acceptTest);
  const rejectTest = useShipStore((s) => s.rejectTest);
  const isResponding = useShipStore((s) => s.respondingTestIds.has(ship.id));

  if (!ship.acceptanceTest || ship.status !== "acceptance-test") return null;

  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-amber-400">
          Acceptance Test Required
        </h3>
        {isSafeUrl(ship.acceptanceTest.url) ? (
          <a
            href={ship.acceptanceTest.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink className="h-3 w-3" />
            Open in browser
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">
            {ship.acceptanceTest.url}
          </span>
        )}
      </div>

      {/* Checks */}
      <ul className="text-xs text-muted-foreground space-y-1 mb-3">
        {ship.acceptanceTest.checks.map((check, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span className="h-1 w-1 rounded-full bg-muted-foreground" />
            {check}
          </li>
        ))}
      </ul>

      {/* Actions */}
      {isResponding ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Processing...
        </div>
      ) : showFeedback ? (
        <div className="flex gap-2">
          <Input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What needs to be fixed..."
            className="text-xs"
          />
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              rejectTest(ship.id, feedback);
              setShowFeedback(false);
              setFeedback("");
            }}
            disabled={!feedback.trim()}
          >
            Send
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowFeedback(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            className="gap-1"
            onClick={() => acceptTest(ship.id)}
          >
            <Check className="h-3 w-3" />
            Accept
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => setShowFeedback(true)}
          >
            <X className="h-3 w-3" />
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}
