import { useUIStore } from "@/stores/uiStore";

export function CrashBanner() {
  const previousCrash = useUIStore((s) => s.previousCrash);
  const setPreviousCrash = useUIStore((s) => s.setPreviousCrash);

  if (!previousCrash) return null;

  return (
    <div className="bg-destructive/15 border-b border-destructive/30 px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive">
            Engine crashed previously ({previousCrash.context})
          </p>
          <p className="mt-1 text-muted-foreground">
            {previousCrash.timestamp} — {previousCrash.message}
          </p>
          {previousCrash.stack && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                Stack trace
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                {previousCrash.stack}
              </pre>
            </details>
          )}
        </div>
        <button
          onClick={() => setPreviousCrash(null)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
