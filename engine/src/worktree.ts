import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Worktree } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function getRepoRoot(repoPath: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], repoPath);
}

export async function create(
  worktreePath: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  const parentDir = dirname(worktreePath);
  await mkdir(parentDir, { recursive: true });

  // Determine the repo root from parent or cwd
  const repoRoot = await getRepoRoot(parentDir).catch(() => {
    // If parent isn't in a git repo yet, go up until we find one
    return dirname(parentDir);
  });

  await git(["fetch", "origin", baseBranch], repoRoot);

  // Clean up stale worktree/branch from a previous failed sortie
  if (await exists(worktreePath)) {
    await git(["worktree", "remove", worktreePath, "--force"], repoRoot);
  }
  // Delete local branch if it already exists
  await git(["branch", "-D", branchName], repoRoot).catch(() => {});
  // Delete remote branch if it already exists
  await git(["push", "origin", "--delete", branchName], repoRoot).catch(() => {});

  await git(
    ["worktree", "add", "-b", branchName, worktreePath, `origin/${baseBranch}`],
    repoRoot,
  );
}

export async function remove(worktreePath: string, knownRepoRoot?: string): Promise<void> {
  const repoRoot = knownRepoRoot ?? await getRepoRoot(worktreePath).catch(() => null);
  if (!repoRoot) return;

  // Get the main repo root (first worktree listed)
  const mainRoot = await git(["worktree", "list", "--porcelain"], repoRoot)
    .then((output) => {
      const firstLine = output.split("\n")[0];
      return firstLine?.replace("worktree ", "") ?? repoRoot;
    })
    .catch(() => repoRoot);

  await git(["worktree", "remove", worktreePath, "--force"], mainRoot);
}

export async function list(repoRoot: string): Promise<Worktree[]> {
  const raw = await git(["worktree", "list", "--porcelain"], repoRoot);
  if (!raw) return [];

  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as Worktree);
      current = { path: line.replace("worktree ", "") };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.replace("HEAD ", "");
    } else if (line.startsWith("branch ")) {
      current.branch = line.replace("branch refs/heads/", "");
    }
  }
  if (current.path) worktrees.push(current as Worktree);

  return worktrees;
}

export async function listFeatureWorktrees(repoRoot: string): Promise<Worktree[]> {
  const all = await list(repoRoot);
  return all.filter((w) => w.branch?.startsWith("feature/"));
}

export async function forceRemove(worktreePath: string, knownRepoRoot?: string): Promise<void> {
  const repoRoot = knownRepoRoot ?? await getRepoRoot(worktreePath).catch(() => null);
  if (!repoRoot) return;

  const mainRoot = await git(["worktree", "list", "--porcelain"], repoRoot)
    .then((output) => {
      const firstLine = output.split("\n")[0];
      return firstLine?.replace("worktree ", "") ?? repoRoot;
    })
    .catch(() => repoRoot);

  // Remove only the target worktree — do NOT run `git worktree prune` here
  // because prune operates globally and can destroy other active Ships' worktrees.
  try {
    await git(["worktree", "remove", worktreePath, "--force"], mainRoot);
  } catch (err) {
    console.warn(`[worktree] Force remove failed for ${worktreePath}:`, err);
  }
}

export async function symlinkSettings(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  const settingsSource = join(repoRoot, ".claude", "settings.local.json");
  if (!(await exists(settingsSource))) return;

  const settingsDir = join(worktreePath, ".claude");
  await mkdir(settingsDir, { recursive: true });

  const target = join(settingsDir, "settings.local.json");
  if (await exists(target)) return;

  await symlink(settingsSource, target);
}

export async function isWebProject(worktreePath: string): Promise<boolean> {
  return exists(join(worktreePath, "package.json"));
}

export function toKebabCase(str: string): string {
  return str
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/_/g, "-")
    .toLowerCase()
    .slice(0, 40);
}
