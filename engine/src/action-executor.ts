import type { ShipManager } from "./ship-manager.js";
import type { BridgeAction, FleetRepo, FleetSkillSources, OrganizeOperation } from "./types.js";
import * as github from "./github.js";

/**
 * Extract all repo strings referenced by a BridgeAction.
 */
function getActionRepos(action: BridgeAction): string[] {
  switch (action.action) {
    case "list-issues":
    case "create-issue":
    case "close-issue":
    case "edit-issue":
    case "organize-issues":
      return [action.repo];
    case "sortie":
      return action.requests.map((r) => r.repo);
    case "ship-status":
    case "stop-ship":
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
    repoRemotes: string[],
    fleetRepos: FleetRepo[],
    skillSources?: FleetSkillSources,
    shipExtraPrompt?: string,
  ): Promise<string> {
    // Validate that all repos in the action are in the fleet's whitelist
    const actionRepos = getActionRepos(action);
    const repoSet = new Set(repoRemotes);
    for (const repo of actionRepos) {
      if (!repoSet.has(repo)) {
        console.warn(
          `[action-executor] Repo "${repo}" is not in fleet's registered repos: [${repoRemotes.join(", ")}]`,
        );
        return `[Action Rejected] Repo "${repo}" is not registered in this fleet. Registered repos: ${repoRemotes.join(", ")}`;
      }
    }

    switch (action.action) {
      case "sortie":
        return this.executeSortie(fleetId, action, fleetRepos, skillSources, shipExtraPrompt);
      case "create-issue":
        return this.executeCreateIssue(action);
      case "edit-issue":
        return this.executeEditIssue(action);
      case "list-issues":
        return this.executeListIssues(action);
      case "ship-status":
        return this.executeShipStatus(fleetId);
      case "close-issue":
        return this.executeCloseIssue(action);
      case "stop-ship":
        return this.executeStopShip(action);
      case "organize-issues":
        return this.executeOrganizeIssues(action);
      default:
        return `Unknown action: ${(action as { action: string }).action}`;
    }
  }

  private async executeSortie(
    fleetId: string,
    action: Extract<BridgeAction, { action: "sortie" }>,
    fleetRepos: FleetRepo[],
    skillSources?: FleetSkillSources,
    shipExtraPrompt?: string,
  ): Promise<string> {
    const results: string[] = [];
    for (const req of action.requests) {
      try {
        const repoEntry = fleetRepos.find(
          (r) => r.remote === req.repo || r.localPath === req.repo,
        );
        if (!repoEntry) {
          results.push(
            `Failed to launch ${req.repo}#${req.issueNumber}: No local path registered for repo "${req.repo}"`,
          );
          continue;
        }
        const ship = await this.shipManager.sortie(
          fleetId,
          req.repo,
          req.issueNumber,
          repoEntry.localPath,
          skillSources,
          shipExtraPrompt,
          req.skill,
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
      // Append dependencies section to body if dependsOn is provided
      let body = action.body;
      if (action.dependsOn && action.dependsOn.length > 0) {
        const depLines = action.dependsOn
          .map((n) => `- Depends on #${n}`)
          .join("\n");
        body = `${body}\n\n## Dependencies\n${depLines}`;
      }

      const issue = await github.createIssue(
        action.repo,
        action.title,
        body,
        action.labels,
      );

      // Set up parent sub-issue relationship (decomposition)
      if (action.parentIssue) {
        await github.addSubIssue(
          action.repo,
          action.parentIssue,
          issue.number,
        );
      }

      return `[Issue Created] #${issue.number}: ${issue.title} (${action.repo})`;
    } catch (err) {
      return `[Issue Creation Failed] ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async executeEditIssue(
    action: Extract<BridgeAction, { action: "edit-issue" }>,
  ): Promise<string> {
    try {
      const results: string[] = [];

      // If comment is provided, use `gh issue comment`
      if (action.comment) {
        await github.commentOnIssue(
          action.repo,
          action.issueNumber,
          action.comment,
        );
        results.push(`Comment added to #${action.issueNumber}`);
      }

      // If title, body, or label changes are provided, use `gh issue edit`
      const hasEditFields =
        action.title !== undefined ||
        action.body !== undefined ||
        (action.addLabels && action.addLabels.length > 0) ||
        (action.removeLabels && action.removeLabels.length > 0);

      if (hasEditFields) {
        await github.editIssue(action.repo, action.issueNumber, {
          title: action.title,
          body: action.body,
          addLabels: action.addLabels,
          removeLabels: action.removeLabels,
        });
        const fields: string[] = [];
        if (action.title !== undefined) fields.push("title");
        if (action.body !== undefined) fields.push("body");
        if (action.addLabels?.length) fields.push(`+labels: ${action.addLabels.join(", ")}`);
        if (action.removeLabels?.length) fields.push(`-labels: ${action.removeLabels.join(", ")}`);
        results.push(`Issue #${action.issueNumber} updated (${fields.join(", ")})`);
      }

      // Set up parent sub-issue relationship
      if (action.parentIssue) {
        await github.addSubIssue(
          action.repo,
          action.parentIssue,
          action.issueNumber,
        );
        results.push(`Sub-issue of #${action.parentIssue}`);
      }

      return `[Issue Edit] ${results.join("; ")} (${action.repo})`;
    } catch (err) {
      return `[Issue Edit Failed] ${err instanceof Error ? err.message : String(err)}`;
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

      // For each issue, check sub-issues and body dependencies to determine blocked/unblocked
      const lines: string[] = [];
      for (const issue of issues) {
        const subIssues = await github.getSubIssues(action.repo, issue.number);
        const openSubDeps = subIssues.filter((s) => s.state === "OPEN");
        const openBodyDeps = await github.getOpenBodyDependencies(action.repo, issue.body);

        const allBlockers = [
          ...openSubDeps.map((d) => `#${d.number}`),
          ...openBodyDeps.map((n) => `#${n}`),
        ];
        // Deduplicate in case a dependency appears in both
        const uniqueBlockers = [...new Set(allBlockers)];
        const blocked = uniqueBlockers.length > 0;
        const status = blocked
          ? `BLOCKED (by ${uniqueBlockers.join(", ")})`
          : "UNBLOCKED";
        const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
        lines.push(`  #${issue.number}: ${issue.title}${labels} — ${status}`);
      }

      return `[Issues in ${action.repo}]\n${lines.join("\n")}`;
    } catch (err) {
      return `[List Issues Failed] ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async executeCloseIssue(
    action: Extract<BridgeAction, { action: "close-issue" }>,
  ): Promise<string> {
    try {
      if (action.comment) {
        await github.commentOnIssue(action.repo, action.issueNumber, action.comment);
      }
      await github.closeIssue(action.repo, action.issueNumber);
      return `[Issue Closed] #${action.issueNumber} (${action.repo})`;
    } catch (err) {
      return `[Close Issue Failed] ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private executeStopShip(
    action: Extract<BridgeAction, { action: "stop-ship" }>,
  ): string {
    const killed = this.shipManager.stopShip(action.shipId);
    if (killed) {
      return `[Ship Stopped] ${action.shipId}`;
    }
    return `[Stop Ship Failed] Ship ${action.shipId} not found or already stopped`;
  }

  private async executeOrganizeIssues(
    action: Extract<BridgeAction, { action: "organize-issues" }>,
  ): Promise<string> {
    const results: string[] = [];
    for (const op of action.operations) {
      try {
        const result = await this.executeOrganizeOp(action.repo, op);
        results.push(result);
      } catch (err) {
        results.push(`[Op Failed] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return `[Organize Results]\n${results.join("\n")}`;
  }

  private async executeOrganizeOp(
    repo: string,
    op: OrganizeOperation,
  ): Promise<string> {
    switch (op.op) {
      case "create": {
        const issue = await github.createIssue(repo, op.title, op.body, op.labels);
        if (op.parentIssue) {
          await github.addSubIssue(repo, op.parentIssue, issue.number);
        }
        return `Created #${issue.number}: ${issue.title}`;
      }
      case "edit": {
        if (op.comment) {
          await github.commentOnIssue(repo, op.issueNumber, op.comment);
        }
        const hasEditFields = op.title !== undefined || op.body !== undefined ||
          (op.addLabels && op.addLabels.length > 0) ||
          (op.removeLabels && op.removeLabels.length > 0);
        if (hasEditFields) {
          await github.editIssue(repo, op.issueNumber, {
            title: op.title,
            body: op.body,
            addLabels: op.addLabels,
            removeLabels: op.removeLabels,
          });
        }
        if (op.parentIssue) {
          await github.addSubIssue(repo, op.parentIssue, op.issueNumber);
        }
        return `Updated #${op.issueNumber}`;
      }
      case "close": {
        if (op.comment) {
          await github.commentOnIssue(repo, op.issueNumber, op.comment);
        }
        await github.closeIssue(repo, op.issueNumber);
        return `Closed #${op.issueNumber}`;
      }
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
