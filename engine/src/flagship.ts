import { ProcessManager } from "./process-manager.js";
import { CommanderManager } from "./commander.js";

/**
 * FlagshipManager handles Ship management sessions.
 * Responsible for: sortie, ship-status, ship-stop, ship-resume,
 * /hotfix, Lookout alerts, Gate monitoring.
 */
export class FlagshipManager extends CommanderManager {
  constructor(processManager: ProcessManager) {
    super(processManager, "flagship");
  }

  protected getSkillNames(): string[] {
    return [
      "admiral-protocol",
      "gate-plan-review",
      "gate-code-review",
      "sortie",
      "issue-manage",
      "investigate",
      "read-issue",
      "hotfix",
    ];
  }
}
