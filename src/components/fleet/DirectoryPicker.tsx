import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Folder, FolderOpen, ArrowUp, Loader2 } from "lucide-react";
import { wsClient } from "@/lib/ws-client";
import type { ServerMessage } from "@/types";

interface DirectoryPickerProps {
  open: boolean;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export function DirectoryPicker({
  open,
  onSelect,
  onCancel,
}: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const requestDir = useCallback((path?: string) => {
    setLoading(true);
    setError(null);
    wsClient.send({ type: "fs:list-dir", data: { path } });
  }, []);

  useEffect(() => {
    if (!open) return;
    setEntries([]);
    setError(null);
    setLoading(true);

    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === "fs:dir-listing") {
        const data = msg.data as {
          path: string;
          entries: DirEntry[];
        };
        setCurrentPath(data.path);
        setPathInput(data.path);
        setEntries(data.entries);
        setLoading(false);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      } else if (msg.type === "error") {
        const data = msg.data as { source: string; message: string };
        if (data.source === "fs:list-dir") {
          setError(data.message);
          setLoading(false);
        }
      }
    });

    requestDir();

    return unsub;
  }, [open, requestDir]);

  const navigateTo = (dirName: string) => {
    requestDir(currentPath + "/" + dirName);
  };

  const navigateUp = () => {
    const lastSlash = currentPath.lastIndexOf("/");
    const parent = lastSlash > 0 ? currentPath.slice(0, lastSlash) : "/";
    requestDir(parent);
  };

  const handlePathSubmit = () => {
    const trimmed = pathInput.trim();
    if (trimmed) requestDir(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  if (!open) return null;

  const directories = entries.filter((e) => e.isDirectory);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="w-[560px] max-h-[480px] flex flex-col rounded-lg border border-border bg-background shadow-lg">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <FolderOpen className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Select Directory</h3>
        </div>

        {/* Path bar */}
        <div className="flex gap-2 border-b border-border px-4 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={navigateUp}
            disabled={currentPath === "/"}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handlePathSubmit();
            }}
            className="h-8 text-xs font-mono"
          />
        </div>

        {/* Directory listing */}
        <ScrollArea ref={scrollRef} className="flex-1 min-h-0 max-h-[300px]">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && (
            <div className="px-4 py-3 text-sm text-destructive">{error}</div>
          )}
          {!loading && !error && directories.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No subdirectories
            </div>
          )}
          {!loading &&
            !error &&
            directories.map((entry) => (
              <button
                key={entry.name}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-muted/50 transition-colors"
                onClick={() => navigateTo(entry.name)}
              >
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[340px]">
            {currentPath}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => onSelect(currentPath)}
              disabled={!currentPath}
            >
              Select
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
