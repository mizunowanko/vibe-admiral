import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Issue, LabelOps, PRStatus } from "./types.js";

const execFileAsync = promisify(execFile);

async function gh(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { cwd });
  return stdout.trim();
}

export async function listIssues(
  repo: string,
  label?: string,
): Promise<Issue[]> {
  const args = [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,title,body,labels",
    "--limit",
    "100",
  ];
  if (label) {
    args.push("--label", label);
  }
  const raw = await gh(args);
  if (!raw) return [];
  const issues = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
  }>;
  return issues.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    labels: i.labels.map((l) => l.name),
    state: "open" as const,
  }));
}

export async function getIssue(repo: string, number: number): Promise<Issue> {
  const raw = await gh([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,title,body,labels,state",
  ]);
  const i = JSON.parse(raw) as {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    state: string;
  };
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    labels: i.labels.map((l) => l.name),
    state: i.state.toLowerCase() === "open" ? "open" : "closed",
  };
}

export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels?: string[],
  dependsOn?: number[],
): Promise<Issue> {
  let finalBody = body;
  if (dependsOn !== undefined && dependsOn.length > 0) {
    const depLines = dependsOn.map((n) => `- Depends on #${n}`).join("\n");
    finalBody = `${body}\n\n## Dependencies\n${depLines}`;
  }
  const labelList = labels && labels.length > 0 ? labels : [];
  const args = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    finalBody,
  ];
  for (const label of labelList) {
    args.push("--label", label);
  }
  // gh issue create outputs the issue URL (e.g. https://github.com/owner/repo/issues/123)
  const url = await gh(args);
  const match = url.match(/\/issues\/(\d+)$/);
  if (!match) {
    throw new Error(`Failed to parse issue number from gh output: ${url}`);
  }
  const issueNumber = Number(match[1]);
  return getIssue(repo, issueNumber);
}

export async function updateLabels(
  repo: string,
  number: number,
  ops: LabelOps,
): Promise<void> {
  const args = ["issue", "edit", String(number), "--repo", repo];
  if (ops.remove) {
    args.push("--remove-label", ops.remove);
  }
  if (ops.add) {
    args.push("--add-label", ops.add);
  }
  await gh(args);
}

export async function editIssue(
  repo: string,
  number: number,
  opts: {
    title?: string;
    body?: string;
    addLabels?: string[];
    removeLabels?: string[];
    dependsOn?: number[];
  },
): Promise<{ edited: boolean; dependsOnAppended: boolean }> {
  const hasTitle = opts.title !== undefined;
  const hasBody = opts.body !== undefined;
  const hasAddLabels =
    opts.addLabels !== undefined && opts.addLabels.length > 0;
  const hasRemoveLabels =
    opts.removeLabels !== undefined && opts.removeLabels.length > 0;
  const hasDependsOn =
    opts.dependsOn !== undefined && opts.dependsOn.length > 0;

  if (!hasTitle && !hasBody && !hasAddLabels && !hasRemoveLabels && !hasDependsOn) {
    throw new Error(
      "editIssue requires at least one field to change (title, body, addLabels, removeLabels, or dependsOn)",
    );
  }

  const result = { edited: false, dependsOnAppended: false };

  // Resolve the final body without mutating opts.
  // dependsOn processing may produce a new body even when opts.body is undefined.
  let resolvedBody: string | undefined = opts.body;

  // Handle dependsOn: append Dependencies section to the issue body
  if (hasDependsOn) {
    const depLines = opts.dependsOn!
      .map((n) => `- Depends on #${n}`)
      .join("\n");
    const depSection = `\n\n## Dependencies\n${depLines}`;
    const hasOtherEdits = hasTitle || hasBody || hasAddLabels || hasRemoveLabels;
    try {
      const issue = await getIssue(repo, number);
      const existingBody = issue.body ?? "";
      // Replace existing Dependencies section or append.
      // Uses the same regex as parseDependencies for round-trip consistency.
      const newBody = DEPENDENCIES_SECTION_RE.test(existingBody)
        ? existingBody.replace(DEPENDENCIES_SECTION_RE, `## Dependencies\n${depLines}`)
        : existingBody + depSection;
      // If body was also explicitly provided, the explicit body takes precedence;
      // dependsOn section will be appended to the explicit body instead
      if (!hasBody) {
        resolvedBody = newBody;
      } else {
        resolvedBody = opts.body! + depSection;
      }
      result.dependsOnAppended = true;
    } catch (err) {
      if (!hasOtherEdits) {
        // dependsOn was the only requested operation and it failed — throw
        throw new Error(
          `Failed to append dependsOn to #${number}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Other edits were also requested — log warning and proceed with those
      console.warn(
        `[github] Failed to append dependsOn to #${number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const hasEditFields =
    hasTitle || resolvedBody !== undefined || hasAddLabels || hasRemoveLabels;

  if (hasEditFields) {
    const args = ["issue", "edit", String(number), "--repo", repo];
    if (hasTitle) {
      args.push("--title", opts.title!);
    }
    if (resolvedBody !== undefined) {
      args.push("--body", resolvedBody);
    }
    if (hasAddLabels) {
      for (const label of opts.addLabels!) {
        args.push("--add-label", label);
      }
    }
    if (hasRemoveLabels) {
      for (const label of opts.removeLabels!) {
        args.push("--remove-label", label);
      }
    }
    await gh(args);
    result.edited = true;
  }

  return result;
}

export async function commentOnIssue(
  repo: string,
  number: number,
  comment: string,
): Promise<void> {
  await gh([
    "issue",
    "comment",
    String(number),
    "--repo",
    repo,
    "--body",
    comment,
  ]);
}

export async function closeIssue(
  repo: string,
  number: number,
): Promise<void> {
  await gh([
    "issue",
    "close",
    String(number),
    "--repo",
    repo,
  ]);
}

export async function reopenIssue(
  repo: string,
  number: number,
): Promise<void> {
  await gh([
    "issue",
    "reopen",
    String(number),
    "--repo",
    repo,
  ]);
}

export async function getDefaultBranch(repo: string): Promise<string> {
  const raw = await gh([
    "repo",
    "view",
    repo,
    "--json",
    "defaultBranchRef",
    "--jq",
    ".defaultBranchRef.name",
  ]);
  return raw;
}

export async function getPRStatus(
  repo: string,
  prNumber: number,
): Promise<PRStatus> {
  const raw = await gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "number,state,mergeable,statusCheckRollup",
  ]);
  const pr = JSON.parse(raw) as {
    number: number;
    state: string;
    mergeable: string;
    statusCheckRollup: Array<{
      status: string;
      conclusion: string;
    }> | null;
  };

  const checks = pr.statusCheckRollup;
  let checksStatus: PRStatus["checksStatus"];

  if (!checks || checks.length === 0) {
    checksStatus = "no-checks";
  } else if (checks.some((c) => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "CANCELLED")) {
    checksStatus = "failed";
  } else if (checks.every((c) => c.status === "COMPLETED")) {
    checksStatus = "passed";
  } else {
    checksStatus = "pending";
  }

  return {
    number: pr.number,
    state: pr.state,
    mergeable: pr.mergeable === "MERGEABLE",
    checksStatus,
  };
}

/**
 * Check if a merged PR exists for a given branch.
 * Returns the PR number if found, null otherwise.
 */
export async function getMergedPRForBranch(
  repo: string,
  branchName: string,
): Promise<{ number: number; url: string } | null> {
  try {
    const raw = await gh([
      "pr", "list",
      "--head", branchName,
      "--repo", repo,
      "--state", "merged",
      "--json", "number,url",
      "--jq", ".[0]",
    ]);
    if (!raw) return null;
    return JSON.parse(raw) as { number: number; url: string };
  } catch {
    return null;
  }
}

export async function listSubIssues(
  repo: string,
  number: number,
): Promise<Issue[]> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return [];
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          subIssues(first: 50) {
            nodes { number title state }
          }
        }
      }
    }`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repoName}`,
    "-F",
    `number=${number}`,
  ]);
  const result = JSON.parse(raw) as {
    data: {
      repository: {
        issue: {
          subIssues: {
            nodes: Array<{ number: number; title: string; state: string }>;
          };
        };
      };
    };
  };
  return result.data.repository.issue.subIssues.nodes.map((n) => ({
    number: n.number,
    title: n.title,
    body: "",
    labels: [],
    state: n.state === "OPEN" ? ("open" as const) : ("closed" as const),
  }));
}

export async function addSubIssue(
  repo: string,
  parentNumber: number,
  childNumber: number,
): Promise<void> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return;

  // Get node IDs for parent and child issues
  const parentRaw = await gh([
    "api",
    "graphql",
    "-f",
    `query=query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) { id }
      }
    }`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repoName}`,
    "-F",
    `number=${parentNumber}`,
  ]);
  const childRaw = await gh([
    "api",
    "graphql",
    "-f",
    `query=query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) { id }
      }
    }`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repoName}`,
    "-F",
    `number=${childNumber}`,
  ]);

  const parentId = (
    JSON.parse(parentRaw) as {
      data: { repository: { issue: { id: string } } };
    }
  ).data.repository.issue.id;
  const childId = (
    JSON.parse(childRaw) as {
      data: { repository: { issue: { id: string } } };
    }
  ).data.repository.issue.id;

  await gh([
    "api",
    "graphql",
    "-f",
    `query=mutation($parentId: ID!, $childId: ID!) {
      addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
        issue { id }
      }
    }`,
    "-f",
    `parentId=${parentId}`,
    "-f",
    `childId=${childId}`,
  ]);
}

// Regex to locate the "## Dependencies" heading at the start of a line.
// Uses the m flag so ^ matches line starts. [^\S\r\n]* allows trailing
// horizontal whitespace after the heading. Anchoring to ^## prevents
// false positives from "### Dependencies" or deeper headings.
const DEPENDENCIES_HEADING_RE = /^## Dependencies[^\S\r\n]*\r?\n/m;

// Regex used by editIssue to replace the full Dependencies section
// (heading + content). Greedily captures content, then stops at the next
// h2 heading (\n## followed by a non-# char or end of line) or end of string.
const DEPENDENCIES_SECTION_RE =
  /^## Dependencies[^\S\r\n]*\r?\n[\s\S]*?(?=\r?\n## |\r?\n##\r?$|$(?![\r\n]))/m;

/**
 * Parse "## Dependencies" section from issue body and extract issue numbers.
 * Looks for lines like "- Depends on #42".
 */
export function parseDependencies(body: string): number[] {
  if (!body) return [];
  const headingMatch = DEPENDENCIES_HEADING_RE.exec(body);
  if (!headingMatch) return [];

  // Extract the content after the heading until the next ## heading or end
  const start = headingMatch.index + headingMatch[0].length;
  const rest = body.slice(start);
  // Find the next h2 heading (## at line start, not ### or deeper)
  const nextH2 = rest.match(/\r?\n##(?!#)/);
  const section = nextH2 ? rest.slice(0, nextH2.index) : rest;

  const nums = new Set<number>();
  for (const m of section.matchAll(/#(\d+)/g)) {
    nums.add(Number(m[1]));
  }
  return [...nums];
}

/**
 * Parse dependencies from issue body and check which ones are still open.
 * Returns open dependency issue numbers.
 */
export async function getOpenBodyDependencies(
  repo: string,
  body: string,
): Promise<number[]> {
  const depNums = parseDependencies(body);
  if (depNums.length === 0) return [];

  const results = await Promise.all(
    depNums.map(async (num) => {
      try {
        const issue = await getIssue(repo, num);
        return issue.state === "open" ? num : null;
      } catch {
        // If we can't fetch the issue, assume it's not blocking
        return null;
      }
    }),
  );
  return results.filter((n): n is number => n !== null);
}

/**
 * Extract issue numbers from `depends-on/<N>` labels.
 * Example: ["depends-on/42", "type/feature", "depends-on/99"] → [42, 99]
 */
export function parseDependsOnLabels(labels: string[]): number[] {
  const nums: number[] = [];
  for (const label of labels) {
    const match = label.match(/^depends-on\/(\d+)$/);
    if (match) {
      nums.push(Number(match[1]));
    }
  }
  return nums;
}

/**
 * Check which `depends-on/<N>` label dependencies are still open.
 * Returns open dependency issue numbers.
 */
export async function getOpenDependsOnDeps(
  repo: string,
  labels: string[],
): Promise<number[]> {
  const depNums = parseDependsOnLabels(labels);
  if (depNums.length === 0) return [];

  const results = await Promise.all(
    depNums.map(async (num) => {
      try {
        const issue = await getIssue(repo, num);
        return issue.state === "open" ? num : null;
      } catch {
        // If we can't fetch the issue, assume it's not blocking
        return null;
      }
    }),
  );
  return results.filter((n): n is number => n !== null);
}

