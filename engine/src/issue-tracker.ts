import * as github from "./github.js";
import type { Issue, ShipProcess } from "./types.js";

export interface UnblockedIssue extends Issue {
  repo: string;
}

export async function getUnblockedTodoIssues(
  repo: string,
): Promise<UnblockedIssue[]> {
  const issues = await github.listIssues(repo, "todo");
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
  if (subIssues.length === 0) return false;
  return subIssues.some((s) => s.state === "open");
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
