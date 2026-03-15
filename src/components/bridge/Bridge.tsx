import { useRef, useEffect } from "react";
import { useBridge } from "@/hooks/useBridge";
import { BridgeMessage } from "./BridgeMessage";
import { BridgeInput } from "./BridgeInput";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageSquare } from "lucide-react";

interface BridgeProps {
  fleetId: string | null;
}

export function Bridge({ fleetId }: BridgeProps) {
  const { messages, sendMessage } = useBridge(fleetId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (!fleetId) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a fleet to open the Bridge
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <MessageSquare className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Bridge</h2>
        <span className="text-xs text-muted-foreground">
          Central command for issue management and ship coordination
        </span>
      </div>

      {/* Messages */}
      <ScrollArea ref={scrollRef} className="flex-1 p-4">
        <div className="space-y-3">
          {messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">
              Bridge is ready. Send a command to manage issues and coordinate ships.
            </p>
          )}
          {messages.map((msg, i) => (
            <BridgeMessage key={i} message={msg} />
          ))}
        </div>
      </ScrollArea>

      {/* Input */}
      <BridgeInput onSend={sendMessage} />
    </div>
  );
}
