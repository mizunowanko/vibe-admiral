import { mkdir, writeFile, unlink, rename, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const ESCORT_STASH_DIR = ".escort-stash";

const STASH_RULES = ["commander-rules.md", "cli-subprocess.md"];

const ESCORT_SKILLS = new Set([
  "escort-planning-gate",
  "escort-implementing-gate",
  "escort-acceptance-test-gate",
  "shared-read-issue",
]);

export class EscortFilesystemManager {
  private shipCustomInstructions = new Map<string, string | undefined>();
  private cleanupPromises = new Map<string, Promise<void>>();

  storeShipCustomInstructions(parentShipId: string, text: string | undefined): void {
    this.shipCustomInstructions.set(parentShipId, text);
  }

  async awaitPendingCleanup(parentShipId: string): Promise<void> {
    const pendingCleanup = this.cleanupPromises.get(parentShipId);
    if (pendingCleanup) {
      await pendingCleanup.catch(() => {});
      this.cleanupPromises.delete(parentShipId);
    }
  }

  startCleanup(parentShipId: string, worktreePath: string | undefined): void {
    const cleanupPromise = (async () => {
      if (worktreePath) {
        await this.restoreFromEscortStash(worktreePath).catch((err) => {
          console.warn(`[escort-fs] Failed to restore stashed files for ${parentShipId.slice(0, 8)}...:`, err);
        });
      }
      await this.restoreShipCustomInstructions(parentShipId, worktreePath).catch((err) => {
        console.warn(`[escort-fs] Failed to restore Ship customInstructions for ${parentShipId.slice(0, 8)}...:`, err);
      });
    })();
    this.cleanupPromises.set(parentShipId, cleanupPromise);
  }

  async deployCustomInstructions(
    worktreePath: string,
    customInstructionsText?: string,
  ): Promise<void> {
    const rulesDir = join(worktreePath, ".claude", "rules");
    const filePath = join(rulesDir, "custom-instructions.md");

    if (!customInstructionsText) {
      return;
    }

    await mkdir(rulesDir, { recursive: true });
    await writeFile(filePath, customInstructionsText, "utf-8");
  }

  async stashForEscort(worktreePath: string): Promise<void> {
    const claudeDir = join(worktreePath, ".claude");
    const stashBase = join(claudeDir, ESCORT_STASH_DIR);
    const stashRulesDir = join(stashBase, "rules");
    const stashSkillsDir = join(stashBase, "skills");

    try {
      await mkdir(stashRulesDir, { recursive: true });
      await mkdir(stashSkillsDir, { recursive: true });
    } catch (mkdirErr) {
      console.warn(`[escort-fs] stashForEscort mkdir failed, retrying:`, mkdirErr);
      await mkdir(stashRulesDir, { recursive: true });
      await mkdir(stashSkillsDir, { recursive: true });
    }

    const rulesDir = join(claudeDir, "rules");
    for (const ruleName of STASH_RULES) {
      const src = join(rulesDir, ruleName);
      const dest = join(stashRulesDir, ruleName);
      await rename(src, dest).catch(() => {});
    }

    const claudeMdSrc = join(worktreePath, "CLAUDE.md");
    const claudeMdDest = join(stashBase, "CLAUDE.md");
    await rename(claudeMdSrc, claudeMdDest).catch(() => {});

    const skillsDir = join(claudeDir, "skills");
    let entries: string[];
    try {
      entries = await readdir(skillsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ESCORT_SKILLS.has(entry)) continue;
      const src = join(skillsDir, entry);
      const dest = join(stashSkillsDir, entry);
      await rename(src, dest).catch(() => {});
    }

    console.log(`[escort-fs] Stashed CLAUDE.md + Ship rules/skills to ${ESCORT_STASH_DIR}`);
  }

  async restoreFromEscortStash(worktreePath: string): Promise<void> {
    const claudeDir = join(worktreePath, ".claude");
    const stashBase = join(claudeDir, ESCORT_STASH_DIR);

    const stashRulesDir = join(stashBase, "rules");
    const rulesDir = join(claudeDir, "rules");
    try {
      const entries = await readdir(stashRulesDir);
      for (const entry of entries) {
        await rename(join(stashRulesDir, entry), join(rulesDir, entry)).catch(() => {});
      }
    } catch {
      // No stashed rules
    }

    const stashSkillsDir = join(stashBase, "skills");
    const skillsDir = join(claudeDir, "skills");
    try {
      const entries = await readdir(stashSkillsDir);
      for (const entry of entries) {
        await rename(join(stashSkillsDir, entry), join(skillsDir, entry)).catch(() => {});
      }
    } catch {
      // No stashed skills
    }

    const claudeMdStash = join(stashBase, "CLAUDE.md");
    const claudeMdDest = join(worktreePath, "CLAUDE.md");
    await rename(claudeMdStash, claudeMdDest).catch(() => {});

    await rm(stashBase, { recursive: true, force: true }).catch(() => {});

    console.log(`[escort-fs] Restored CLAUDE.md + Ship rules/skills from ${ESCORT_STASH_DIR}`);
  }

  private async restoreShipCustomInstructions(parentShipId: string, worktreePath: string | undefined): Promise<void> {
    if (!worktreePath) return;

    const shipCi = this.shipCustomInstructions.get(parentShipId);
    const rulesDir = join(worktreePath, ".claude", "rules");
    const filePath = join(rulesDir, "custom-instructions.md");

    if (shipCi) {
      await mkdir(rulesDir, { recursive: true });
      await writeFile(filePath, shipCi, "utf-8");
    } else {
      await unlink(filePath).catch(() => {});
    }

    this.shipCustomInstructions.delete(parentShipId);
  }
}
