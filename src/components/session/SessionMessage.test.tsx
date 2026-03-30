/**
 * SessionMessage — display-rule scope filter tests.
 *
 * Guards the ADR-0006 message visibility matrix:
 * | Message subtype        | Dock | Flagship   | Ship          |
 * |------------------------|------|------------|---------------|
 * | ship-status            |  -   | all Ships  | own Ship only |
 * | gate-check-request     |  -   | all Ships  | own Ship only |
 * | lookout-alert          |  -   | all Ships  | -             |
 * | commander-status       |  ✓   | ✓          | -             |
 * | escort-log             |  -   | -          | ✓             |
 * | User message           |  ✓   | ✓          | -             |
 *
 * These tests protect against regressions during #774 (message routing)
 * and #778 (store normalization).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionMessage } from "./SessionMessage";
import { resetAllStores, makeMessage } from "@/test-utils/store-helpers";
import { useFleetStore } from "@/stores/fleetStore";

// Mock react-markdown to avoid ESM/remark complexity in jsdom
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("@/lib/remark-issue-link", () => ({ remarkIssueLink: () => {} }));

beforeEach(() => {
  resetAllStores();
  // Set a fleet so ChatMessage's remarkPlugins logic doesn't break
  useFleetStore.setState({
    fleets: [{ id: "f1", name: "Test", repos: [], createdAt: "" }],
    selectedFleetId: "f1",
    selectedFleet: { id: "f1", name: "Test", repos: [], createdAt: "" },
  });
});

describe("SessionMessage context filtering", () => {
  // --- User messages ---

  it("renders user messages in command (Dock/Flagship) context", () => {
    const msg = makeMessage({ type: "user", content: "hello commander" });
    const { container } = render(
      <SessionMessage message={msg} context="command" />,
    );
    expect(container.textContent).toContain("hello commander");
  });

  it("suppresses user messages in ship context", () => {
    const msg = makeMessage({ type: "user", content: "should not appear" });
    const { container } = render(
      <SessionMessage message={msg} context="ship" />,
    );
    expect(container.innerHTML).toBe("");
  });

  // --- Commander status ---

  it("renders commander-status in command context", () => {
    const msg = makeMessage({
      type: "system",
      subtype: "commander-status",
      content: "Dock connected",
    });
    const { container } = render(
      <SessionMessage message={msg} context="command" />,
    );
    expect(container.textContent).toContain("Dock connected");
  });

  it("suppresses commander-status in ship context", () => {
    const msg = makeMessage({
      type: "system",
      subtype: "commander-status",
      content: "Dock connected",
    });
    const { container } = render(
      <SessionMessage message={msg} context="ship" />,
    );
    expect(container.innerHTML).toBe("");
  });

  // --- Escort log ---

  it("renders escort-log in ship context", () => {
    const msg = makeMessage({
      type: "assistant",
      content: "Escort review feedback",
      meta: { category: "escort-log" as const },
    });
    const { container } = render(
      <SessionMessage message={msg} context="ship" />,
    );
    expect(container.textContent).toContain("Escort");
    expect(container.textContent).toContain("Escort review feedback");
  });

  it("suppresses escort-log in command context", () => {
    const msg = makeMessage({
      type: "assistant",
      content: "Escort review feedback",
      meta: { category: "escort-log" as const },
    });
    const { container } = render(
      <SessionMessage message={msg} context="command" />,
    );
    expect(container.innerHTML).toBe("");
  });

  // --- Lookout alert ---

  it("suppresses lookout-alert in ship context", () => {
    const msg = makeMessage({
      type: "system",
      subtype: "lookout-alert",
      content: "Stall detected",
      meta: {
        category: "lookout-alert" as const,
        alertType: "gate-wait-stall" as const,
        shipId: "s1",
      },
    });
    const { container } = render(
      <SessionMessage message={msg} context="ship" />,
    );
    expect(container.innerHTML).toBe("");
  });

  // --- Ship status ---

  it("renders ship-status in command (Flagship) context", () => {
    const msg = makeMessage({
      type: "system",
      subtype: "ship-status",
      content: "Ship #42: coding",
    });
    const { container } = render(
      <SessionMessage message={msg} context="command" />,
    );
    expect(container.textContent).toContain("Ship #42: coding");
  });

  it("renders ship-status in ship context", () => {
    const msg = makeMessage({
      type: "system",
      subtype: "ship-status",
      content: "Ship #42: plan",
    });
    const { container } = render(
      <SessionMessage message={msg} context="ship" />,
    );
    expect(container.textContent).toContain("Ship #42: plan");
  });

  // --- Rate limit status ---

  it("renders rate-limit-status as amber pill", () => {
    const msg = makeMessage({
      type: "system",
      subtype: "rate-limit-status",
      content: "Rate limit hit — retrying in 30s",
    });
    const { container } = render(
      <SessionMessage message={msg} context="command" />,
    );
    expect(container.textContent).toContain("Rate limit hit");
  });

  // --- Assistant messages ---

  it("renders assistant messages in command context", () => {
    const msg = makeMessage({
      type: "assistant",
      content: "Here is my analysis",
    });
    const { container } = render(
      <SessionMessage message={msg} context="command" />,
    );
    expect(container.textContent).toContain("Here is my analysis");
  });

  it("renders assistant messages in ship context", () => {
    const msg = makeMessage({
      type: "assistant",
      content: "Implementing feature",
    });
    const { container } = render(
      <SessionMessage message={msg} context="ship" />,
    );
    expect(container.textContent).toContain("Implementing feature");
  });
});

describe("SessionMessage system message routing", () => {
  it("routes gate-check-request to SystemMessageCard", () => {
    const msg = makeMessage({
      type: "system",
      subtype: "gate-check-request",
      content: "Gate check",
      meta: {
        category: "gate-check-request" as const,
        gatePhase: "plan-gate",
        gateType: "plan-review" as const,
        issueNumber: 42,
        shipId: "s1",
      },
    });
    const { container } = render(
      <SessionMessage message={msg} context="command" />,
    );
    // SystemMessageCard renders compact gate info
    expect(container.innerHTML).not.toBe("");
  });

  it("routes pr-review-request to SystemMessageCard", () => {
    const msg = makeMessage({
      type: "system",
      subtype: "pr-review-request",
      content: "PR review",
      meta: {
        category: "pr-review-request" as const,
        prNumber: 100,
        prUrl: "https://github.com/test/repo/pull/100",
        shipId: "s1",
      },
    });
    const { container } = render(
      <SessionMessage message={msg} context="command" />,
    );
    expect(container.innerHTML).not.toBe("");
  });
});

describe("Escort message visual distinction", () => {
  it("renders escort messages with [Escort] label and sky-blue styling", () => {
    const msg = makeMessage({
      type: "assistant",
      content: "Plan looks good",
      meta: { category: "escort-log" as const },
    });
    const { container } = render(
      <SessionMessage message={msg} context="ship" />,
    );
    expect(container.textContent).toContain("[Escort]");
    // Check for sky-blue themed border class
    const wrapper = container.querySelector("[class*='border-sky']");
    expect(wrapper).not.toBeNull();
  });

  it("renders regular assistant messages without [Escort] label", () => {
    const msg = makeMessage({
      type: "assistant",
      content: "Regular ship output",
    });
    const { container } = render(
      <SessionMessage message={msg} context="ship" />,
    );
    expect(container.textContent).not.toContain("[Escort]");
  });
});
