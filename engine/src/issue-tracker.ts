import * as github from "./github.js";
import type { Issue, ShipProcess } from "./types.js";

export interface UnblockedIssue extends Issue {
  repo: string;
}

export async function getUnblockedTodoIssues(
  repo: string,
): Promise<UnblockedIssue[]> {
  const issues = await github.listIssues(repo, "todo");

  const results = await Promise.all(
    issues.map(async (issue) => {
      const blocked = await isBlocked(repo, issue.number, issue.body);
      return blocked ? null : { ...issue, repo };
    }),
  );

  return results.filter((r): r is UnblockedIssue => r !== null);
}

export async function isBlocked(
  repo: string,
  number: number,
  body?: string,
): Promise<boolean> {
  const subIssues = await github.listSubIssues(repo, number);
  const blockedBySub = subIssues.some((s) => s.state === "open");
  if (blockedBySub) return true;

  // Use provided body to avoid redundant API call
  const issueBody =
    body ?? (await github.getIssue(repo, number)).body;
  const openBodyDeps = await github.getOpenBodyDependencies(repo, issueBody);
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
