import type { ShipManager } from "./ship-manager.js";
import type { BridgeAction } from "./types.js";
import * as github from "./github.js";

/**
 * Extract all repo strings referenced by a BridgeAction.
 */
function getActionRepos(action: BridgeAction): string[] {
  switch (action.action) {
    case "list-issues":
    case "create-issue":
      return [action.repo];
    case "sortie":
      return action.requests.map((r) => r.repo);
    case "ship-status":
      return [];
  }
}

export class ActionExecutor {
  private shipManager: ShipManager;

  constructor(
    shipManager: ShipManager,
  ) {
    this.shipManager = shipManager;
  }

  async execute(
    fleetId: string,
    action: BridgeAction,
    fleetRepos: string[],
  ): Promise<string> {
    // Validate that all repos in the action are in the fleet's whitelist
    const actionRepos = getActionRepos(action);
    const repoSet = new Set(fleetRepos);
    for (const repo of actionRepos) {
      if (!repoSet.has(repo)) {
        console.warn(
          `[action-executor] Repo "${repo}" is not in fleet's registered repos: [${fleetRepos.join(", ")}]`,
        );
        return `[Action Rejected] Repo "${repo}" is not registered in this fleet. Registered repos: ${fleetRepos.join(", ")}`;
      }
    }

    switch (action.action) {
      case "sortie":
        return this.executeSortie(fleetId, action);
      case "create-issue":
        return this.executeCreateIssue(action);
      case "list-issues":
        return this.executeListIssues(action);
      case "ship-status":
        return this.executeShipStatus(fleetId);
      default:
        return `Unknown action: ${(action as { action: string }).action}`;
    }
  }

  private async executeSortie(
    fleetId: string,
    action: Extract<BridgeAction, { action: "sortie" }>,
  ): Promise<string> {
    const results: string[] = [];
    for (const req of action.requests) {
      try {
        const ship = await this.shipManager.sortie(
          fleetId,
          req.repo,
          req.issueNumber,
        );
        results.push(
          `Ship ${ship.id} launched for ${req.repo}#${req.issueNumber} (${ship.issueTitle})`,
        );
      } catch (err) {
        results.push(
          `Failed to launch ${req.repo}#${req.issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return `[Sortie Results]\n${results.join("\n")}`;
  }

  private async executeCreateIssue(
    action: Extract<BridgeAction, { action: "create-issue" }>,
  ): Promise<string> {
    try {
      const issue = await github.createIssue(
        action.repo,
        action.title,
        action.body,
        action.labels,
      );

      // Set up parent sub-issue relationship
      if (action.parentIssue) {
        await github.addSubIssue(
          action.repo,
          action.parentIssue,
          issue.number,
        );
      }

      // Set up dependency sub-issue relationships
      if (action.dependsOn) {
        for (const depNumber of action.dependsOn) {
          await github.addSubIssue(action.repo, depNumber, issue.number);
        }
      }

      return `[Issue Created] #${issue.number}: ${issue.title} (${action.repo})`;
    } catch (err) {
      return `[Issue Creation Failed] ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async executeListIssues(
    action: Extract<BridgeAction, { action: "list-issues" }>,
  ): Promise<string> {
    try {
      const issues = await github.listIssues(action.repo, action.label);
      if (issues.length === 0) {
        return `[Issues] No issues found in ${action.repo}${action.label ? ` with label "${action.label}"` : ""}`;
      }

      // For each issue, check sub-issues to determine blocked/unblocked
      const lines: string[] = [];
      for (const issue of issues) {
        const subIssues = await github.getSubIssues(action.repo, issue.number);
        const openDeps = subIssues.filter((s) => s.state === "OPEN");
        const blocked = openDeps.length > 0;
        const status = blocked
          ? `BLOCKED (by ${openDeps.map((d) => `#${d.number}`).join(", ")})`
          : "UNBLOCKED";
        const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
        lines.push(`  #${issue.number}: ${issue.title}${labels} — ${status}`);
      }

      return `[Issues in ${action.repo}]\n${lines.join("\n")}`;
    } catch (err) {
      return `[List Issues Failed] ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async executeShipStatus(fleetId: string): Promise<string> {
    const ships = this.shipManager.getShipsByFleet(fleetId);
    if (ships.length === 0) {
      return "[Ship Status] No active ships in this fleet.";
    }

    const lines = ships.map(
      (s) =>
        `  Ship ${s.id.slice(0, 8)}... #${s.issueNumber} (${s.issueTitle}): ${s.status}`,
    );
    return `[Ship Status]\n${lines.join("\n")}`;
  }
}
