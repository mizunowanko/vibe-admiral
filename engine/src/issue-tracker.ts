import * as github from "./github.js";
import type { Issue, ShipProcess } from "./types.js";

export interface UnblockedIssue extends Issue {
  repo: string;
}

/**
 * Type label priority order (lower index = higher priority).
 * Issues with priority/critical override this entirely and come first.
 */
const TYPE_PRIORITY_ORDER: string[] = [
  "type/bug",
  "type/skill",
  "type/infra",
  "type/test",
  "type/refactor",
  "type/feature",
];

/**
 * Sort issues by sortie priority:
 * 1. priority/critical issues first (regardless of type)
 * 2. Remaining sorted by type label priority (bug > skill > infra > test > refactor > feature)
 * 3. Issues without a recognized type label come last
 * 4. Stable sort within same tier (preserves original order, typically issue number ascending)
 */
export function sortIssuesByPriority<T extends Issue>(issues: T[]): T[] {
  return [...issues].sort((a, b) => {
    const aCritical = a.labels.includes("priority/critical");
    const bCritical = b.labels.includes("priority/critical");

    // priority/critical always comes first
    if (aCritical && !bCritical) return -1;
    if (!aCritical && bCritical) return 1;

    // Within same critical tier, sort by type label priority
    const aTypeIdx = TYPE_PRIORITY_ORDER.findIndex((t) => a.labels.includes(t));
    const bTypeIdx = TYPE_PRIORITY_ORDER.findIndex((t) => b.labels.includes(t));

    // -1 means no recognized type label → sort to end
    const aRank = aTypeIdx === -1 ? TYPE_PRIORITY_ORDER.length : aTypeIdx;
    const bRank = bTypeIdx === -1 ? TYPE_PRIORITY_ORDER.length : bTypeIdx;

    return aRank - bRank;
  });
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

  return sortIssuesByPriority(unblocked);
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
