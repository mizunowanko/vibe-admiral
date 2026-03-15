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
    "--json",
    "number,title,body,labels",
  ];
  for (const label of labelList) {
    args.push("--label", label);
  }
  const raw = await gh(args);
  const i = JSON.parse(raw) as {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
  };
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    labels: i.labels.map((l) => l.name),
    state: "open",
  };
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
