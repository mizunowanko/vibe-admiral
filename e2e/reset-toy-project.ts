/**
 * Reset mizunowanko-org/toy-admiral-test to a clean initial state.
 *
 * Steps:
 *  1. Remove all worktrees except main
 *  2. Delete all feature/* branches (local + remote)
 *  3. Close all open PRs
 *  4. Reset main to the initial commit and force-push
 *  5. Reopen issues #1, #3 with "todo" label; close #2, #4
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);

const REPO = "mizunowanko-org/toy-admiral-test";
const LOCAL_REPO = `${process.env.HOME}/Projects/Development/toy-admiral-test`;

// Issues to keep open and mark as "todo" for E2E testing
const ACTIVE_ISSUES = [1, 3];
// Issues to close (too complex or dependent for E2E)
const INACTIVE_ISSUES = [2, 4];

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd });
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err);
    // Non-fatal for cleanup operations
    console.warn(`  [warn] ${cmd} ${args.join(" ")}: ${msg.split("\n")[0]}`);
    return "";
  }
}

async function git(args: string[]): Promise<string> {
  return run("git", args, LOCAL_REPO);
}

async function gh(args: string[]): Promise<string> {
  return run("gh", args);
}

// ── Step 1: Remove all worktrees except main ────────────────────────

async function removeWorktrees(): Promise<void> {
  console.log("Step 1: Removing worktrees...");
  const raw = await git(["worktree", "list", "--porcelain"]);
  if (!raw) return;

  const worktreePaths: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      const path = line.replace("worktree ", "");
      // Skip the main repo itself
      if (path !== LOCAL_REPO) {
        worktreePaths.push(path);
      }
    }
  }

  for (const path of worktreePaths) {
    console.log(`  Removing worktree: ${path}`);
    await git(["worktree", "remove", path, "--force"]);
  }
  console.log(`  Removed ${worktreePaths.length} worktree(s).`);
}

// ── Step 2: Delete feature/* branches ───────────────────────────────

async function deleteBranches(): Promise<void> {
  console.log("Step 2: Deleting feature branches...");

  // Local branches
  const localRaw = await git(["branch", "--list", "feature/*"]);
  const localBranches = localRaw
    .split("\n")
    .map((b) => b.trim().replace(/^\*\s*/, ""))
    .filter(Boolean);

  for (const branch of localBranches) {
    console.log(`  Deleting local branch: ${branch}`);
    await git(["branch", "-D", branch]);
  }

  // Remote branches
  const remoteRaw = await git([
    "branch",
    "-r",
    "--list",
    "origin/feature/*",
  ]);
  const remoteBranches = remoteRaw
    .split("\n")
    .map((b) => b.trim().replace("origin/", ""))
    .filter(Boolean);

  for (const branch of remoteBranches) {
    console.log(`  Deleting remote branch: ${branch}`);
    await git(["push", "origin", "--delete", branch]);
  }

  console.log(
    `  Deleted ${localBranches.length} local + ${remoteBranches.length} remote branch(es).`,
  );
}

// ── Step 3: Close all open PRs ──────────────────────────────────────

async function closeOpenPRs(): Promise<void> {
  console.log("Step 3: Closing open PRs...");
  const raw = await gh([
    "pr",
    "list",
    "--repo",
    REPO,
    "--state",
    "open",
    "--json",
    "number",
  ]);
  if (!raw) return;

  const prs = JSON.parse(raw) as Array<{ number: number }>;
  for (const pr of prs) {
    console.log(`  Closing PR #${pr.number}`);
    await gh(["pr", "close", String(pr.number), "--repo", REPO]);
  }
  console.log(`  Closed ${prs.length} PR(s).`);
}

// ── Step 4: Reset main to initial commit ────────────────────────────

async function resetMain(): Promise<void> {
  console.log("Step 4: Resetting main to initial commit...");

  await git(["checkout", "main"]);

  // Find the very first commit
  const initialCommit = await git(["rev-list", "--max-parents=0", "HEAD"]);
  if (!initialCommit) {
    throw new Error("Could not find initial commit");
  }
  console.log(`  Initial commit: ${initialCommit}`);

  const { stdout } = await execFileAsync(
    "git",
    ["reset", "--hard", initialCommit],
    { cwd: LOCAL_REPO },
  );
  console.log(`  ${stdout.trim()}`);

  // Force push (this is intentional for test repo reset)
  const { stdout: pushOut } = await execFileAsync(
    "git",
    ["push", "--force", "origin", "main"],
    { cwd: LOCAL_REPO },
  );
  if (pushOut.trim()) console.log(`  ${pushOut.trim()}`);

  // Add CLAUDE.md and .claude/settings.json for /implement skill
  console.log("  Adding CLAUDE.md and plugin settings...");
  await setupProjectFiles();

  // Commit and push the setup files
  const { stdout: statusOut } = await execFileAsync(
    "git",
    ["status", "--porcelain"],
    { cwd: LOCAL_REPO },
  );
  if (statusOut.trim()) {
    await execFileAsync(
      "git",
      ["add", "CLAUDE.md", ".claude/skills/implement/SKILL.md", ".gitignore"],
      { cwd: LOCAL_REPO },
    );
    await execFileAsync(
      "git",
      ["commit", "-m", "chore: add CLAUDE.md and plugin settings for vibe-admiral"],
      { cwd: LOCAL_REPO },
    );
    await execFileAsync(
      "git",
      ["push", "--force", "origin", "main"],
      { cwd: LOCAL_REPO },
    );
    console.log("  Project files committed and pushed.");
  }

  console.log("  Main branch reset and force-pushed.");
}

// ── Step 5: Reset issue labels ──────────────────────────────────────

async function resetIssues(): Promise<void> {
  console.log("Step 5: Resetting issue labels...");

  for (const num of ACTIVE_ISSUES) {
    console.log(`  Issue #${num}: reopen + todo label`);
    // Reopen (ignore error if already open)
    await gh(["issue", "reopen", String(num), "--repo", REPO]);
    // Remove "doing" if present, add "todo"
    await gh([
      "issue",
      "edit",
      String(num),
      "--repo",
      REPO,
      "--remove-label",
      "doing",
      "--add-label",
      "todo",
    ]);
  }

  for (const num of INACTIVE_ISSUES) {
    console.log(`  Issue #${num}: close + remove labels`);
    // Remove working labels first
    await gh([
      "issue",
      "edit",
      String(num),
      "--repo",
      REPO,
      "--remove-label",
      "doing",
      "--remove-label",
      "todo",
    ]);
    // Close
    await gh(["issue", "close", String(num), "--repo", REPO]);
  }

  console.log("  Issue labels reset.");
}

// ── Step 4b: Set up project files ───────────────────────────────────

const CLAUDE_MD = `# toy-admiral-test

E2E テスト用のトイプロジェクト。vibe-admiral の統合テストに使用。

## 技術スタック

- TypeScript (Node.js)

## ディレクトリ構成

\`\`\`
src/
  index.ts    メイン
\`\`\`

## コマンド

| Purpose | Command |
|---------|---------|
| Type check | npx tsc --noEmit |

## 実装レイヤー順序

1. src/ (ソースコード)

## 競合リスクエリア

- src/index.ts (共有エントリポイント)
`;

async function setupProjectFiles(): Promise<void> {
  // Write CLAUDE.md
  await writeFile(join(LOCAL_REPO, "CLAUDE.md"), CLAUDE_MD);

  // Copy /implement skill to .claude/skills/ (Claude Code skill format)
  const skillSrc = join(
    __dirname,
    "..",
    "skills",
    "implement",
    "SKILL.md",
  );
  const skillDest = join(LOCAL_REPO, ".claude", "skills", "implement");
  await mkdir(skillDest, { recursive: true });
  const skillContent = await readFile(skillSrc, "utf-8");
  await writeFile(join(skillDest, "SKILL.md"), skillContent);

  // Add .gitignore for worktrees
  await writeFile(
    join(LOCAL_REPO, ".gitignore"),
    ".worktrees/\n.claude/workflow-state.json\n.claude/plans/\n",
  );
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nResetting ${REPO} to initial state...\n`);

  await removeWorktrees();
  await deleteBranches();
  await closeOpenPRs();
  await resetMain();
  await resetIssues();

  console.log("\nReset complete!\n");
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
