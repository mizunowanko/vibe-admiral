import { ProcessManager } from "./process-manager.js";
import { CommanderManager } from "./commander.js";

/**
 * DockManager handles Issue management sessions.
 * Responsible for: clarity assessment, triage, priority decisions,
 * /investigate, /issue-manage.
 */
export class DockManager extends CommanderManager {
  constructor(processManager: ProcessManager) {
    super(processManager, "dock");
  }

  protected getSkillNames(): string[] {
    return [
      "dock-ship-status",
      "issue-manage",
      "investigate",
      "read-issue",
      "sortie",
    ];
  }
}
