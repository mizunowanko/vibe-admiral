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
): Promise<Issue> {
  const labelList = labels && labels.length > 0 ? labels : ["todo"];
  const args = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
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
  },
): Promise<void> {
  const args = ["issue", "edit", String(number), "--repo", repo];
  if (opts.title !== undefined) {
    args.push("--title", opts.title);
  }
  if (opts.body !== undefined) {
    args.push("--body", opts.body);
  }
  if (opts.addLabels) {
    for (const label of opts.addLabels) {
      args.push("--add-label", label);
    }
  }
  if (opts.removeLabels) {
    for (const label of opts.removeLabels) {
      args.push("--remove-label", label);
    }
  }
  await gh(args);
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
    "--comment",
    "Closed via vibe-admiral Ship completion",
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
    statusCheckRollup: Array<{ status: string }>;
  };
  const allPassed = pr.statusCheckRollup?.every(
    (c) => c.status === "COMPLETED",
  );
  return {
    number: pr.number,
    state: pr.state,
    mergeable: pr.mergeable === "MERGEABLE",
    checksStatus: allPassed ? "passed" : "pending",
  };
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

/**
 * Parse "## Dependencies" section from issue body and extract issue numbers.
 * Looks for lines like "- Depends on #42".
 */
export function parseDependencies(body: string): number[] {
  if (!body) return [];
  const sectionMatch = body.match(/## Dependencies\s*\n([\s\S]*?)(?:\n##|$)/);
  if (!sectionMatch?.[1]) return [];
  const section = sectionMatch[1];
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

export async function getSubIssues(
  repo: string,
  issueNumber: number,
): Promise<Array<{ number: number; title: string; state: string }>> {
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
    `number=${issueNumber}`,
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
  return result.data.repository.issue.subIssues.nodes;
}
