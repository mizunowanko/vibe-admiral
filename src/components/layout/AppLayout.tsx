import { useEngine } from "@/hooks/useEngine";
import { Sidebar } from "./Sidebar";
import { MainPanel } from "./MainPanel";
import { CrashBanner } from "./CrashBanner";

export function AppLayout() {
  useEngine();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <CrashBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <MainPanel />
      </div>
    </div>
  );
}
