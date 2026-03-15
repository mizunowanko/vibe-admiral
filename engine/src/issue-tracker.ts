import * as github from "./github.js";
import type { Issue, ShipProcess } from "./types.js";

export interface UnblockedIssue extends Issue {
  repo: string;
}

export async function getUnblockedTodoIssues(
  repo: string,
): Promise<UnblockedIssue[]> {
  const issues = await github.listIssues(repo, "status/todo");
  const unblocked: UnblockedIssue[] = [];

  for (const issue of issues) {
    const blocked = await isBlocked(repo, issue.number);
    if (!blocked) {
      unblocked.push({ ...issue, repo });
    }
  }

  return unblocked;
}

export async function isBlocked(
  repo: string,
  number: number,
): Promise<boolean> {
  const subIssues = await github.listSubIssues(repo, number);
  const blockedBySub = subIssues.some((s) => s.state === "open");
  if (blockedBySub) return true;

  // Also check body-based dependencies
  const issue = await github.getIssue(repo, number);
  const openBodyDeps = await github.getOpenBodyDependencies(repo, issue.body);
  return openBodyDeps.length > 0;
}

export function getActiveShips(
  ships: Map<string, ShipProcess>,
): Map<number, ShipProcess> {
  const active = new Map<number, ShipProcess>();
  for (const [, ship] of ships) {
    if (ship.status !== "done" && ship.status !== "error") {
      active.set(ship.issueNumber, ship);
    }
  }
  return active;
}
