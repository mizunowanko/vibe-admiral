import { ProcessManager } from "./process-manager.js";
import { CommanderManager } from "./commander.js";

/**
 * FlagshipManager handles Ship management sessions.
 * Responsible for: sortie, ship-status, ship-pause, ship-resume, ship-abandon, ship-reactivate,
 * /hotfix, Lookout alerts, Gate monitoring.
 */
export class FlagshipManager extends CommanderManager {
  constructor(processManager: ProcessManager) {
    super(processManager, "flagship");
  }

  protected getSkillNames(): string[] {
    return [
      "admiral-protocol",
      "sortie",
      "issue-manage",
      "investigate",
      "read-issue",
      "hotfix",
    ];
  }
}
