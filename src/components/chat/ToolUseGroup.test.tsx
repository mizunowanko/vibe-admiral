/**
 * ToolUseGroup — collapsible tool_use grouping tests.
 *
 * Guards against regressions during #774 (message routing):
 * - Groups display correct tool_use count
 * - Collapsed by default, expanded on click
 * - Only tool_use messages are counted (tool_result excluded)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolUseGroup } from "./ToolUseGroup";
import { resetAllStores, makeMessage } from "@/test-utils/store-helpers";
import { useFleetStore } from "@/stores/fleetStore";
import type { ToolUseGroupItem } from "@/lib/group-tool-messages";

// Mock react-markdown
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("@/lib/remark-issue-link", () => ({ remarkIssueLink: () => {} }));

beforeEach(() => {
  resetAllStores();
  useFleetStore.setState({
    fleets: [{ id: "f1", name: "Test", repos: [], createdAt: "" }],
    selectedFleetId: "f1",
    selectedFleet: { id: "f1", name: "Test", repos: [], createdAt: "" },
  });
});

function makeGroup(toolUseCount: number, includeResults = true): ToolUseGroupItem {
  const messages = [];
  for (let i = 0; i < toolUseCount; i++) {
    messages.push(
      makeMessage({
        type: "tool_use",
        tool: `Tool${i + 1}`,
        content: `input ${i + 1}`,
        timestamp: 1000 + i * 2,
      }),
    );
    if (includeResults) {
      messages.push(
        makeMessage({
          type: "tool_result",
          content: `result ${i + 1}`,
          timestamp: 1000 + i * 2 + 1,
        }),
      );
    }
  }
  return {
    kind: "tool-group",
    messages,
    timestamp: 1000,
  };
}

describe("ToolUseGroup", () => {
  it("shows correct tool_use count (excluding tool_result)", () => {
    const group = makeGroup(3);
    render(<ToolUseGroup group={group} />);

    expect(screen.getByText("3 tool uses")).toBeInTheDocument();
  });

  it("is collapsed by default (shows ▶)", () => {
    const group = makeGroup(2);
    render(<ToolUseGroup group={group} />);

    // Only the group-level arrow exists when collapsed
    expect(screen.getAllByText("▶")).toHaveLength(1);
    expect(screen.queryByText("▼")).not.toBeInTheDocument();
  });

  it("expands on click and shows ▼", () => {
    const group = makeGroup(2);
    render(<ToolUseGroup group={group} />);

    // Click the group button (first button in the tree)
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]!);

    // Group header now shows ▼, child tool_use/tool_result may show ▶
    expect(screen.getByText("▼")).toBeInTheDocument();
  });

  it("shows child messages when expanded", () => {
    const group = makeGroup(2);
    render(<ToolUseGroup group={group} />);

    // Collapsed — tool names not visible
    expect(screen.queryByText("[Tool1]")).not.toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByRole("button"));

    // Tool names should now be visible
    expect(screen.getByText("[Tool1]")).toBeInTheDocument();
    expect(screen.getByText("[Tool2]")).toBeInTheDocument();
  });

  it("collapses back on second click", () => {
    const group = makeGroup(2);
    render(<ToolUseGroup group={group} />);

    const button = screen.getByRole("button");
    fireEvent.click(button); // expand
    fireEvent.click(button); // collapse

    expect(screen.getByText("▶")).toBeInTheDocument();
    expect(screen.queryByText("[Tool1]")).not.toBeInTheDocument();
  });

  it("counts only tool_use messages when results are interleaved", () => {
    const group = makeGroup(4, true);
    // 4 tool_use + 4 tool_result = 8 messages total
    expect(group.messages).toHaveLength(8);

    render(<ToolUseGroup group={group} />);
    expect(screen.getByText("4 tool uses")).toBeInTheDocument();
  });
});
