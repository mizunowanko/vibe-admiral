import { describe, expect, it } from "vitest";
import {
  extractRequests,
  isBridgeRequest,
  stripRequestBlocks,
  parseStreamMessage,
  extractSessionId,
} from "../../stream-parser.js";

/**
 * Integration test: admiral-request pipeline
 *
 * Tests the full flow of:
 *   Flagship stdout text → extractRequests() → validateRequest() →
 *   isBridgeRequest() routing
 *
 * This exercises stream-parser together with request validation,
 * ensuring that well-formed admiral-request blocks are correctly parsed,
 * validated, classified, and that malformed ones are silently rejected.
 *
 * Note: Ship requests (nothing-to-do, status-transition) were removed in #439/#442.
 * All admiral-requests are now Flagship-only.
 */
describe("admiral-request pipeline (integration)", () => {
  describe("sortie requests from Flagship", () => {
    it("parses a valid sortie request block", () => {
      const text = `I'll launch a sortie now.

\`\`\`admiral-request
{ "request": "sortie", "items": [{ "repo": "owner/repo", "issueNumber": 42 }] }
\`\`\`

That should do it.`;

      const requests = extractRequests(text);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.request).toBe("sortie");
      expect(isBridgeRequest(requests[0]!)).toBe(true);
    });

    it("parses sortie with multiple items and skill", () => {
      const text = `\`\`\`admiral-request
{ "request": "sortie", "items": [
  { "repo": "owner/repo", "issueNumber": 10, "skill": "implement" },
  { "repo": "owner/repo", "issueNumber": 11 }
] }
\`\`\``;

      const requests = extractRequests(text);
      expect(requests).toHaveLength(1);
      const req = requests[0]!;
      if (req.request === "sortie") {
        expect(req.items).toHaveLength(2);
        expect(req.items[0]!.skill).toBe("implement");
        expect(req.items[1]!.skill).toBeUndefined();
      }
    });

    it("rejects sortie with empty items array", () => {
      const text = `\`\`\`admiral-request
{ "request": "sortie", "items": [] }
\`\`\``;

      const requests = extractRequests(text);
      expect(requests).toHaveLength(0);
    });

    it("rejects sortie with invalid repo format", () => {
      const text = `\`\`\`admiral-request
{ "request": "sortie", "items": [{ "repo": "invalid-repo", "issueNumber": 42 }] }
\`\`\``;

      const requests = extractRequests(text);
      expect(requests).toHaveLength(0);
    });
  });

  describe("removed request types", () => {
    it("rejects status-transition requests (removed in #439)", () => {
      const text = `\`\`\`admiral-request
{ "request": "status-transition", "status": "implementing" }
\`\`\``;

      const requests = extractRequests(text);
      expect(requests).toHaveLength(0);
    });

    it("rejects nothing-to-do requests (removed in #442)", () => {
      const text = `\`\`\`admiral-request
{ "request": "nothing-to-do", "reason": "Issue already resolved" }
\`\`\``;

      const requests = extractRequests(text);
      expect(requests).toHaveLength(0);
    });
  });

  describe("multiple requests in a single message", () => {
    it("extracts multiple requests from one text block", () => {
      const text = `Here are my actions:

\`\`\`admiral-request
{ "request": "ship-stop", "shipId": "abc" }
\`\`\`

And also:

\`\`\`admiral-request
{ "request": "ship-status" }
\`\`\``;

      const requests = extractRequests(text);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.request).toBe("ship-stop");
      expect(requests[1]!.request).toBe("ship-status");
    });

    it("skips invalid blocks among valid ones", () => {
      const text = `\`\`\`admiral-request
{ "request": "ship-status" }
\`\`\`

\`\`\`admiral-request
{ broken json
\`\`\`

\`\`\`admiral-request
{ "request": "ship-stop", "shipId": "x" }
\`\`\``;

      const requests = extractRequests(text);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.request).toBe("ship-status");
      expect(requests[1]!.request).toBe("ship-stop");
    });
  });

  describe("stripRequestBlocks", () => {
    it("removes request blocks and preserves surrounding text", () => {
      const text = `Hello world

\`\`\`admiral-request
{ "request": "ship-status" }
\`\`\`

Goodbye`;

      const stripped = stripRequestBlocks(text);
      expect(stripped).toContain("Hello world");
      expect(stripped).toContain("Goodbye");
      expect(stripped).not.toContain("admiral-request");
    });
  });

  describe("parseStreamMessage → extractRequests pipeline", () => {
    it("parses assistant message containing admiral-request", () => {
      const raw = {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: `Launching sortie now.\n\n\`\`\`admiral-request\n{ "request": "sortie", "items": [{ "repo": "owner/repo", "issueNumber": 42 }] }\n\`\`\``,
            },
          ],
        },
      };

      const parsed = parseStreamMessage(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("assistant");

      const requests = extractRequests(parsed!.content!);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.request).toBe("sortie");
    });

    it("drops init messages before extracting requests", () => {
      const raw = {
        type: "system",
        subtype: "init",
        session_id: "sess-123",
      };

      const sessionId = extractSessionId(raw);
      expect(sessionId).toBe("sess-123");

      const parsed = parseStreamMessage(raw);
      expect(parsed).toBeNull();
    });
  });

  describe("request routing classification", () => {
    it("classifies all Flagship request types as bridge requests", () => {
      const flagshipTypes = [
        `{ "request": "sortie", "items": [{ "repo": "o/r", "issueNumber": 1 }] }`,
        `{ "request": "ship-status" }`,
        `{ "request": "ship-stop", "shipId": "x" }`,
        `{ "request": "ship-resume", "shipId": "x" }`,
        `{ "request": "pr-review-result", "shipId": "x", "prNumber": 1, "verdict": "approve" }`,
      ];

      for (const json of flagshipTypes) {
        const text = `\`\`\`admiral-request\n${json}\n\`\`\``;
        const requests = extractRequests(text);
        expect(requests.length).toBeGreaterThan(0);
        expect(isBridgeRequest(requests[0]!)).toBe(true);
      }
    });
  });
});
