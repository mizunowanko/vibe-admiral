import type { StreamMessage, BridgeAction } from "./types.js";

const VALID_ACTIONS = new Set([
  "list-issues",
  "create-issue",
  "sortie",
  "ship-status",
]);

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

const TITLE_MAX_LENGTH = 256;
const BODY_MAX_LENGTH = 65536;

/**
 * Validate a parsed object as a BridgeAction.
 * Returns the validated action or null if invalid.
 */
function validateAction(obj: unknown): BridgeAction | null {
  if (typeof obj !== "object" || obj === null) {
    console.warn("[stream-parser] Action is not an object:", obj);
    return null;
  }

  const record = obj as Record<string, unknown>;

  // Validate action field
  if (typeof record.action !== "string" || !VALID_ACTIONS.has(record.action)) {
    console.warn(
      "[stream-parser] Invalid action type:",
      record.action,
    );
    return null;
  }

  const action = record.action as BridgeAction["action"];

  // ship-status has no additional fields to validate
  if (action === "ship-status") {
    return { action: "ship-status" };
  }

  // Validate repo for actions that require it
  if (action === "list-issues" || action === "create-issue") {
    if (typeof record.repo !== "string" || !REPO_PATTERN.test(record.repo)) {
      console.warn(
        "[stream-parser] Invalid repo format:",
        record.repo,
      );
      return null;
    }
  }

  switch (action) {
    case "list-issues": {
      const result: { action: "list-issues"; repo: string; label?: string } = {
        action: "list-issues",
        repo: record.repo as string,
      };
      if (record.label !== undefined) {
        if (typeof record.label !== "string") {
          console.warn(
            "[stream-parser] list-issues label must be a string:",
            record.label,
          );
          return null;
        }
        result.label = record.label;
      }
      return result;
    }

    case "create-issue": {
      if (typeof record.title !== "string" || record.title.length === 0) {
        console.warn("[stream-parser] create-issue missing title");
        return null;
      }
      if (record.title.length > TITLE_MAX_LENGTH) {
        console.warn(
          `[stream-parser] create-issue title exceeds ${TITLE_MAX_LENGTH} chars:`,
          record.title.length,
        );
        return null;
      }
      if (typeof record.body !== "string") {
        console.warn("[stream-parser] create-issue missing body");
        return null;
      }
      if (record.body.length > BODY_MAX_LENGTH) {
        console.warn(
          `[stream-parser] create-issue body exceeds ${BODY_MAX_LENGTH} chars:`,
          record.body.length,
        );
        return null;
      }

      const result: {
        action: "create-issue";
        repo: string;
        title: string;
        body: string;
        labels?: string[];
        parentIssue?: number;
        dependsOn?: number[];
      } = {
        action: "create-issue",
        repo: record.repo as string,
        title: record.title,
        body: record.body,
      };

      if (record.labels !== undefined) {
        if (
          !Array.isArray(record.labels) ||
          !record.labels.every((l: unknown) => typeof l === "string")
        ) {
          console.warn("[stream-parser] create-issue labels must be string[]");
          return null;
        }
        result.labels = record.labels as string[];
      }

      if (record.parentIssue !== undefined) {
        if (
          typeof record.parentIssue !== "number" ||
          !Number.isInteger(record.parentIssue) ||
          record.parentIssue <= 0
        ) {
          console.warn(
            "[stream-parser] create-issue parentIssue must be a positive integer",
          );
          return null;
        }
        result.parentIssue = record.parentIssue;
      }

      if (record.dependsOn !== undefined) {
        if (
          !Array.isArray(record.dependsOn) ||
          !record.dependsOn.every(
            (n: unknown) =>
              typeof n === "number" && Number.isInteger(n) && n > 0,
          )
        ) {
          console.warn(
            "[stream-parser] create-issue dependsOn must be positive integer[]",
          );
          return null;
        }
        result.dependsOn = record.dependsOn as number[];
      }

      return result;
    }

    case "sortie": {
      if (!Array.isArray(record.requests)) {
        console.warn("[stream-parser] sortie missing requests array");
        return null;
      }

      const validatedRequests: Array<{ repo: string; issueNumber: number }> =
        [];
      for (const req of record.requests) {
        if (typeof req !== "object" || req === null) {
          console.warn(
            "[stream-parser] sortie request is not an object:",
            req,
          );
          return null;
        }
        const r = req as Record<string, unknown>;
        if (typeof r.repo !== "string" || !REPO_PATTERN.test(r.repo)) {
          console.warn(
            "[stream-parser] sortie request invalid repo:",
            r.repo,
          );
          return null;
        }
        if (
          typeof r.issueNumber !== "number" ||
          !Number.isInteger(r.issueNumber) ||
          r.issueNumber <= 0
        ) {
          console.warn(
            "[stream-parser] sortie request invalid issueNumber:",
            r.issueNumber,
          );
          return null;
        }
        validatedRequests.push({
          repo: r.repo,
          issueNumber: r.issueNumber,
        });
      }

      return { action: "sortie", requests: validatedRequests };
    }

    default:
      return null;
  }
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Transform raw Claude CLI stream-json output into a StreamMessage
 * that the frontend can display.
 *
 * Returns null for messages that should be silently dropped (e.g. hooks, init).
 */
export function parseStreamMessage(
  raw: Record<string, unknown>,
): StreamMessage | null {
  const type = raw.type as string | undefined;

  switch (type) {
    case "assistant": {
      const msg = raw.message as
        | { content?: ContentBlock[] }
        | undefined;
      const blocks = msg?.content ?? [];

      // Extract text blocks
      const texts = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string);

      // Extract tool_use blocks
      const toolUses = blocks.filter((b) => b.type === "tool_use");

      if (texts.length > 0) {
        return {
          type: "assistant",
          content: texts.join("\n"),
        };
      }

      if (toolUses.length > 0) {
        const toolName = toolUses[0]?.name ?? "tool";
        return {
          type: "tool_use",
          tool: toolName,
          content: toolName,
        };
      }

      // Assistant message with no text and no tool_use — skip
      return null;
    }

    case "result": {
      const result = raw.result as string | undefined;
      if (!result) return null;
      return {
        type: "result",
        content: result,
      };
    }

    case "system": {
      const subtype = raw.subtype as string | undefined;
      // Skip hooks and init — not useful for the user
      if (subtype === "init" || subtype?.startsWith("hook")) {
        return null;
      }
      return {
        type: "system",
        subtype,
        content: (raw.content as string) ?? subtype ?? "system",
      };
    }

    default:
      return null;
  }
}

const ACTION_BLOCK_RE = /```admiral-action\n([\s\S]*?)```/g;

/**
 * Extract BridgeAction objects from assistant text containing
 * ```admiral-action ... ``` fenced blocks.
 *
 * Each parsed object is runtime-validated; invalid actions are
 * skipped with a console.warn.
 */
export function extractActions(text: string): BridgeAction[] {
  const actions: BridgeAction[] = [];
  let match: RegExpExecArray | null;
  while ((match = ACTION_BLOCK_RE.exec(text)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1]!);
      const validated = validateAction(parsed);
      if (validated) {
        actions.push(validated);
      }
    } catch {
      // Malformed JSON — skip
      console.warn("[stream-parser] Failed to parse admiral-action JSON");
    }
  }
  ACTION_BLOCK_RE.lastIndex = 0;
  return actions;
}

/**
 * Remove ```admiral-action ... ``` blocks from text for display purposes.
 */
export function stripActionBlocks(text: string): string {
  return text.replace(ACTION_BLOCK_RE, "").trim();
}
