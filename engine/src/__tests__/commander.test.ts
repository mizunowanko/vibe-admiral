import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlagshipManager } from "../flagship.js";
import { DockManager } from "../dock.js";

// Mock admiral-home to use temp directory
let testAdmiralHome: string;
vi.mock("../admiral-home.js", () => ({
  getAdmiralHome: () => testAdmiralHome,
}));

type MockProcessManager = {
  launchCommander: ReturnType<typeof vi.fn>;
  resumeCommander: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendToolResult: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProcessManager(): MockProcessManager {
  return {
    launchCommander: vi.fn(),
    resumeCommander: vi.fn(),
    sendMessage: vi.fn(),
    sendToolResult: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
    kill: vi.fn(),
  };
}

describe("CommanderManager", () => {
  let tmpDir: string;
  let mockPm: MockProcessManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), "commander-test-"));
    testAdmiralHome = tmpDir;
    mockPm = createMockProcessManager();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("FlagshipManager", () => {
    let manager: FlagshipManager;

    beforeEach(() => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
    });

    it("has correct role", () => {
      expect(manager.getProcessIdPrefix()).toBe("flagship-");
    });

    it("generates correct process ID for a fleet", () => {
      expect(manager.getProcessId("fleet-1")).toBe("flagship-fleet-1");
    });
  });

  describe("DockManager", () => {
    let manager: DockManager;

    beforeEach(() => {
      manager = new DockManager(
        mockPm as unknown as ConstructorParameters<typeof DockManager>[0],
      );
    });

    it("has correct role", () => {
      expect(manager.getProcessIdPrefix()).toBe("dock-");
    });

    it("generates correct process ID for a fleet", () => {
      expect(manager.getProcessId("fleet-1")).toBe("dock-fleet-1");
    });
  });

  describe("launch", () => {
    let manager: FlagshipManager;

    beforeEach(() => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
    });

    it("launches a new commander session when no persisted session exists", async () => {
      const sessionId = await manager.launch("fleet-1", "/fleet/path", [], "system prompt");

      expect(sessionId).toBe("flagship-fleet-1");
      expect(mockPm.launchCommander).toHaveBeenCalledWith(
        "flagship-fleet-1",
        "/fleet/path",
        [],
        "system prompt",
        { VIBE_ADMIRAL_FLEET_ID: "fleet-1" },
      );
      expect(mockPm.resumeCommander).not.toHaveBeenCalled();
    });

    it("resumes a persisted session when session ID exists on disk", async () => {
      // Create persisted session file
      const fleetDir = join(tmpDir, "fleet-1");
      await mkdir(fleetDir, { recursive: true });
      await writeFile(
        join(fleetDir, "flagship-session.json"),
        JSON.stringify({ fleetId: "fleet-1", role: "flagship", sessionId: "sess-abc", createdAt: new Date().toISOString() }),
      );

      const sessionId = await manager.launch("fleet-1", "/fleet/path", ["/extra"], "prompt");

      expect(sessionId).toBe("flagship-fleet-1");
      expect(mockPm.resumeCommander).toHaveBeenCalledWith(
        "flagship-fleet-1",
        "sess-abc",
        "/fleet/path",
        ["/extra"],
        "prompt",
        { VIBE_ADMIRAL_FLEET_ID: "fleet-1" },
      );
      expect(mockPm.launchCommander).not.toHaveBeenCalled();
    });

    it("creates a session entry in the sessions map", async () => {
      expect(manager.hasSession("fleet-1")).toBe(false);

      await manager.launch("fleet-1", "/fleet/path", []);

      expect(manager.hasSession("fleet-1")).toBe(true);
    });
  });

  describe("send", () => {
    let manager: FlagshipManager;

    beforeEach(async () => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
      await manager.launch("fleet-1", "/fleet/path", []);
    });

    it("sends a message and adds to history", () => {
      const result = manager.send("fleet-1", "Hello Flagship");

      expect(result).toBe(true);
      expect(mockPm.sendMessage).toHaveBeenCalledWith("flagship-fleet-1", "Hello Flagship", undefined);

      const history = manager.getHistory("fleet-1");
      expect(history.some((m) => m.content === "Hello Flagship")).toBe(true);
    });

    it("re-launches process if it died", () => {
      mockPm.isRunning.mockReturnValue(false);

      manager.send("fleet-1", "Resume please");

      // Should re-launch commander
      expect(mockPm.launchCommander).toHaveBeenCalledTimes(2); // once in launch(), once in send()
    });

    it("resumes session if process died and sessionId is set", async () => {
      manager.setSessionId("fleet-1", "sess-123");
      mockPm.isRunning.mockReturnValue(false);

      manager.send("fleet-1", "Resume with session");

      expect(mockPm.resumeCommander).toHaveBeenCalledWith(
        "flagship-fleet-1",
        "sess-123",
        "/fleet/path",
        [],
        undefined,
      );
    });

    it("returns false for non-existent fleet", () => {
      expect(manager.send("nonexistent", "Hello")).toBe(false);
    });

    it("includes image count in history but sends full images to process", () => {
      const images = [{ base64: "abc", mediaType: "image/png" }];
      manager.send("fleet-1", "Look at this", images);

      const history = manager.getHistory("fleet-1");
      const lastUserMsg = history.filter((m) => m.content === "Look at this").pop();
      expect(lastUserMsg?.imageCount).toBe(1);

      expect(mockPm.sendMessage).toHaveBeenCalledWith(
        "flagship-fleet-1",
        "Look at this",
        images,
      );
    });
  });

  describe("history management", () => {
    let manager: FlagshipManager;

    beforeEach(async () => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
      await manager.launch("fleet-1", "/fleet/path", []);
    });

    it("addToHistory appends messages", () => {
      manager.addToHistory("fleet-1", { type: "assistant", content: "Hello" });
      manager.addToHistory("fleet-1", { type: "assistant", content: "World" });

      const history = manager.getHistory("fleet-1");
      expect(history).toHaveLength(2);
      expect(history[0]!.content).toBe("Hello");
      expect(history[1]!.content).toBe("World");
    });

    it("trims history to MAX_HISTORY (500) entries", () => {
      for (let i = 0; i < 510; i++) {
        manager.addToHistory("fleet-1", { type: "assistant", content: `msg-${i}` });
      }

      const history = manager.getHistory("fleet-1");
      expect(history.length).toBeLessThanOrEqual(500);
      // Should have the most recent messages
      expect(history[history.length - 1]!.content).toBe("msg-509");
    });

    it("getHistory returns empty array for non-existent fleet", () => {
      expect(manager.getHistory("nonexistent")).toEqual([]);
    });

    it("persists history entries to JSONL file", async () => {
      manager.addToHistory("fleet-1", { type: "assistant", content: "Persisted" });

      // Wait for async persistence
      await vi.waitFor(async () => {
        const filePath = join(tmpDir, "fleet-1", "flagship-history.jsonl");
        const content = await readFile(filePath, "utf-8");
        expect(content).toContain("Persisted");
      });
    });

    it("loads history from disk fallback when no in-memory session", async () => {
      // Write history file to disk
      const fleetDir = join(tmpDir, "fleet-2");
      await mkdir(fleetDir, { recursive: true });
      const historyData = [
        JSON.stringify({ type: "assistant", content: "from disk" }),
      ].join("\n") + "\n";
      await writeFile(join(fleetDir, "flagship-history.jsonl"), historyData);

      // getHistoryWithDiskFallback should load from disk for fleet-2 (no session)
      const history = await manager.getHistoryWithDiskFallback("fleet-2");
      expect(history).toHaveLength(1);
      expect(history[0]!.content).toBe("from disk");
    });
  });

  describe("pending questions", () => {
    let manager: FlagshipManager;

    beforeEach(async () => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
      await manager.launch("fleet-1", "/fleet/path", []);
    });

    it("setPendingQuestion stores tool use ID and timestamp", () => {
      manager.setPendingQuestion("fleet-1", "tool-use-abc");

      const pending = manager.getPendingQuestion("fleet-1");
      expect(pending).not.toBeNull();
      expect(pending!.toolUseId).toBe("tool-use-abc");
      expect(pending!.askedAt).toBeGreaterThan(0);
    });

    it("clearPendingQuestion removes the pending state", () => {
      manager.setPendingQuestion("fleet-1", "tool-use-abc");
      manager.clearPendingQuestion("fleet-1");

      expect(manager.getPendingQuestion("fleet-1")).toBeNull();
    });

    it("getPendingQuestion returns null when no question pending", () => {
      expect(manager.getPendingQuestion("fleet-1")).toBeNull();
    });

    it("getPendingQuestion returns null for non-existent fleet", () => {
      expect(manager.getPendingQuestion("nonexistent")).toBeNull();
    });

    it("getSessionsWithPendingQuestion returns all pending sessions", async () => {
      const dockManager = new DockManager(
        mockPm as unknown as ConstructorParameters<typeof DockManager>[0],
      );
      await dockManager.launch("fleet-1", "/fleet/path", []);

      manager.setPendingQuestion("fleet-1", "tool-flagship");
      dockManager.setPendingQuestion("fleet-1", "tool-dock");

      const flagshipPending = manager.getSessionsWithPendingQuestion();
      expect(flagshipPending).toHaveLength(1);
      expect(flagshipPending[0]!.toolUseId).toBe("tool-flagship");

      const dockPending = dockManager.getSessionsWithPendingQuestion();
      expect(dockPending).toHaveLength(1);
      expect(dockPending[0]!.toolUseId).toBe("tool-dock");
    });
  });

  describe("setSessionId", () => {
    let manager: FlagshipManager;

    beforeEach(async () => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
      await manager.launch("fleet-1", "/fleet/path", []);
    });

    it("sets sessionId only once (first capture)", () => {
      manager.setSessionId("fleet-1", "sess-first");
      manager.setSessionId("fleet-1", "sess-second"); // should be ignored

      // Verify by checking that resume uses first sessionId
      mockPm.isRunning.mockReturnValue(false);
      manager.send("fleet-1", "test");

      expect(mockPm.resumeCommander).toHaveBeenCalledWith(
        "flagship-fleet-1",
        "sess-first",
        expect.any(String),
        expect.any(Array),
        undefined,
      );
    });

    it("persists session to disk", async () => {
      manager.setSessionId("fleet-1", "sess-disk");

      await vi.waitFor(async () => {
        const filePath = join(tmpDir, "fleet-1", "flagship-session.json");
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.sessionId).toBe("sess-disk");
      });
    });
  });

  describe("stop", () => {
    let manager: FlagshipManager;

    beforeEach(async () => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
      await manager.launch("fleet-1", "/fleet/path", []);
    });

    it("kills process and removes session", async () => {
      await manager.stop("fleet-1");

      expect(mockPm.kill).toHaveBeenCalledWith("flagship-fleet-1");
      expect(manager.hasSession("fleet-1")).toBe(false);
    });
  });

  describe("stopAll", () => {
    let manager: FlagshipManager;

    beforeEach(async () => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
      await manager.launch("fleet-1", "/fleet/path", []);
      await manager.launch("fleet-2", "/fleet2/path", []);
    });

    it("stops all sessions", async () => {
      await manager.stopAll();

      expect(mockPm.kill).toHaveBeenCalledWith("flagship-fleet-1");
      expect(mockPm.kill).toHaveBeenCalledWith("flagship-fleet-2");
      expect(manager.hasSession("fleet-1")).toBe(false);
      expect(manager.hasSession("fleet-2")).toBe(false);
    });
  });

  describe("deploy and cleanup", () => {
    let manager: FlagshipManager;
    let fleetPath: string;
    let admiralSkillsDir: string;

    beforeEach(async () => {
      manager = new FlagshipManager(
        mockPm as unknown as ConstructorParameters<typeof FlagshipManager>[0],
      );
      // Create a Fleet repo directory and an Admiral skills directory
      fleetPath = join(tmpDir, "fleet-repo");
      admiralSkillsDir = join(tmpDir, "admiral-skills");
      await mkdir(fleetPath, { recursive: true });

      // Create Admiral skills that Flagship expects
      for (const skill of ["admiral-protocol", "sortie", "issue-manage", "investigate", "read-issue", "hotfix", "ship-inspect"]) {
        const skillDir = join(admiralSkillsDir, skill);
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), `# ${skill} skill`);
      }

      // Create commander-rules.md in Admiral repo's .claude/rules/
      const admiralRulesDir = join(admiralSkillsDir, "..", ".claude", "rules");
      await mkdir(admiralRulesDir, { recursive: true });
      await writeFile(join(admiralRulesDir, "commander-rules.md"), "# Commander Rules");
    });

    it("deploys skills from admiralSkillsDir to Fleet repo", async () => {
      await manager.launch("fleet-1", fleetPath, [], "prompt", admiralSkillsDir);

      // Verify skills were deployed to fleet-repo/.claude/skills/
      const sortieSkill = join(fleetPath, ".claude", "skills", "sortie", "SKILL.md");
      const content = await readFile(sortieSkill, "utf-8");
      expect(content).toBe("# sortie skill");

      const inspectSkill = join(fleetPath, ".claude", "skills", "ship-inspect", "SKILL.md");
      const inspectContent = await readFile(inspectSkill, "utf-8");
      expect(inspectContent).toBe("# ship-inspect skill");
    });

    it("deploys commander-rules.md to Fleet repo", async () => {
      await manager.launch("fleet-1", fleetPath, [], "prompt", admiralSkillsDir);

      const rulesPath = join(fleetPath, ".claude", "rules", "commander-rules.md");
      const content = await readFile(rulesPath, "utf-8");
      expect(content).toBe("# Commander Rules");
    });

    it("deploys custom instructions to Fleet repo", async () => {
      await manager.launch("fleet-1", fleetPath, [], "prompt", admiralSkillsDir, "Be polite and helpful.");

      const ciPath = join(fleetPath, ".claude", "rules", "custom-instructions.md");
      const content = await readFile(ciPath, "utf-8");
      expect(content).toContain("Be polite and helpful.");
    });

    it("does not deploy custom-instructions.md when text is not provided", async () => {
      await manager.launch("fleet-1", fleetPath, [], "prompt", admiralSkillsDir);

      const ciPath = join(fleetPath, ".claude", "rules", "custom-instructions.md");
      await expect(stat(ciPath)).rejects.toThrow();
    });

    it("cleans up deployed files on stop", async () => {
      await manager.launch("fleet-1", fleetPath, [], "prompt", admiralSkillsDir, "Be polite.");

      // Verify files exist
      const sortieSkill = join(fleetPath, ".claude", "skills", "sortie", "SKILL.md");
      const rulesPath = join(fleetPath, ".claude", "rules", "commander-rules.md");
      const ciPath = join(fleetPath, ".claude", "rules", "custom-instructions.md");
      await expect(stat(sortieSkill)).resolves.toBeTruthy();
      await expect(stat(rulesPath)).resolves.toBeTruthy();
      await expect(stat(ciPath)).resolves.toBeTruthy();

      // Stop should clean up
      await manager.stop("fleet-1");

      await expect(stat(sortieSkill)).rejects.toThrow();
      await expect(stat(rulesPath)).rejects.toThrow();
      await expect(stat(ciPath)).rejects.toThrow();
    });

    it("Dock deploys its own skill set", async () => {
      const dockManager = new DockManager(
        mockPm as unknown as ConstructorParameters<typeof DockManager>[0],
      );

      // Create dock-ship-status skill
      const dockSkillDir = join(admiralSkillsDir, "dock-ship-status");
      await mkdir(dockSkillDir, { recursive: true });
      await writeFile(join(dockSkillDir, "SKILL.md"), "# dock-ship-status skill");

      await dockManager.launch("fleet-1", fleetPath, [], "prompt", admiralSkillsDir);

      const dockSkill = join(fleetPath, ".claude", "skills", "dock-ship-status", "SKILL.md");
      const content = await readFile(dockSkill, "utf-8");
      expect(content).toBe("# dock-ship-status skill");

      // Dock should NOT have flagship-specific skills like sortie
      const sortieSkill = join(fleetPath, ".claude", "skills", "sortie", "SKILL.md");
      await expect(stat(sortieSkill)).rejects.toThrow();
    });
  });
});
