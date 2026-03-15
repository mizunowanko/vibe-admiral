import { useEngine } from "@/hooks/useEngine";
import { Sidebar } from "./Sidebar";
import { MainPanel } from "./MainPanel";

export function AppLayout() {
  useEngine();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <MainPanel />
    </div>
  );
}
