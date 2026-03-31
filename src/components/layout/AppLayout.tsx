import { useEngine } from "@/hooks/useEngine";
import { Sidebar } from "./Sidebar";
import { MainPanel } from "./MainPanel";
import { CrashBanner } from "./CrashBanner";
import { RestartOverlay } from "./RestartOverlay";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

export function AppLayout() {
  useEngine();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <RestartOverlay />
      <CrashBanner />
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
      >
        <ResizablePanel defaultSize={15} minSize={5}>
          <Sidebar />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={85}>
          <MainPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
