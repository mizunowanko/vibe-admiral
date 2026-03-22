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
  "type/skill",
  "type/bug",
  "type/infra",
  "type/test",
  "type/refactor",
  "type/feature",
];

/**
 * Count the number of `depends-on/<N>` labels on an issue.
 */
function countDependsOn(labels: string[]): number {
  return labels.filter((l) => l.startsWith("depends-on/")).length;
}

/**
 * Sort issues by sortie priority:
 * 1. priority/critical issues first (regardless of type)
 * 2. Remaining sorted by type label priority (skill > bug > infra > test > refactor > feature)
 * 3. Within the same tier, issues with fewer depends-on/ labels come first
 *    (they are likely blockers for other issues and should be resolved sooner)
 * 4. Issues without a recognized type label come last
 * 5. Stable sort within same tier (preserves original order, typically issue number ascending)
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

    if (aRank !== bRank) return aRank - bRank;

    // Within same type tier, fewer depends-on labels = higher priority
    return countDependsOn(a.labels) - countDependsOn(b.labels);
  });
}

export async function getUnblockedReadyIssues(
  repo: string,
): Promise<UnblockedIssue[]> {
  const issues = await github.listIssues(repo, "status/ready");

  const results = await Promise.all(
    issues.map(async (issue) => {
      const blocked = await isBlocked(repo, issue.number, issue.body, issue.labels);
      return blocked ? null : { ...issue, repo };
    }),
  );

  return sortIssuesByPriority(
    results.filter((r): r is UnblockedIssue => r !== null),
  );
}

export async function isBlocked(
  repo: string,
  number: number,
  body?: string,
  labels?: string[],
): Promise<boolean> {
  const subIssues = await github.listSubIssues(repo, number);
  const blockedBySub = subIssues.some((s) => s.state === "open");
  if (blockedBySub) return true;

  // Check depends-on/ labels (primary mechanism)
  if (labels && labels.length > 0) {
    const openLabelDeps = await github.getOpenDependsOnDeps(repo, labels);
    if (openLabelDeps.length > 0) return true;
  }

  // Use provided body to avoid redundant getIssue() API call (legacy fallback)
  const issueBody = body ?? (await github.getIssue(repo, number)).body;
  const openBodyDeps = await github.getOpenBodyDependencies(repo, issueBody);
  return openBodyDeps.length > 0;
}

export function getActiveShips(
  ships: Map<string, ShipProcess>,
): Map<number, ShipProcess> {
  const active = new Map<number, ShipProcess>();
  for (const [, ship] of ships) {
    if (ship.phase !== "done" && !ship.processDead) {
      active.set(ship.issueNumber, ship);
    }
  }
  return active;
}
