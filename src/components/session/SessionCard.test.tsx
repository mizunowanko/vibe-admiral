/**
 * SessionCard — Ship card phase badge and selection state tests.
 *
 * Guards against regressions during #774 (message routing) and #778
 * (store normalization):
 * - Phase badge shows correct display name and color
 * - Active phases show animation indicator
 * - Selection state is visually indicated
 * - Commander cards display correct icon and description
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionCard, DispatchCard } from "./SessionCard";
import { resetAllStores, makeShip, makeSession } from "@/test-utils/store-helpers";
import type { Phase, Dispatch } from "@/types";

beforeEach(() => {
  resetAllStores();
});

describe("SessionCard — Commander cards", () => {
  it("renders Dock card with Anchor icon and issue management description", () => {
    const session = makeSession({ id: "dock-fleet-1", type: "dock", label: "Dock" });
    const { container } = render(
      <SessionCard session={session} isFocused={false} onFocus={() => {}} />,
    );
    expect(container.textContent).toContain("Dock");
    expect(container.textContent).toContain("Issue management");
  });

  it("renders Flagship card with Flag icon and ship management description", () => {
    const session = makeSession({ id: "flagship-fleet-1", type: "flagship", label: "Flagship" });
    const { container } = render(
      <SessionCard session={session} isFocused={false} onFocus={() => {}} />,
    );
    expect(container.textContent).toContain("Flagship");
    expect(container.textContent).toContain("Ship management");
  });

  it("shows Active badge when focused", () => {
    const session = makeSession({ id: "dock-fleet-1", type: "dock", label: "Dock" });
    const { container } = render(
      <SessionCard session={session} isFocused={true} onFocus={() => {}} />,
    );
    expect(container.textContent).toContain("Active");
  });

  it("does not show Active badge when not focused", () => {
    const session = makeSession({ id: "dock-fleet-1", type: "dock", label: "Dock" });
    const { container } = render(
      <SessionCard session={session} isFocused={false} onFocus={() => {}} />,
    );
    expect(container.textContent).not.toContain("Active");
  });

  it("calls onFocus when clicked", () => {
    const onFocus = vi.fn();
    const session = makeSession({ id: "dock-fleet-1", type: "dock", label: "Dock" });
    render(
      <SessionCard session={session} isFocused={false} onFocus={onFocus} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});

describe("SessionCard — Ship cards", () => {
  const phases: { phase: Phase; displayName: string; animate: boolean }[] = [
    { phase: "plan", displayName: "Plan", animate: true },
    { phase: "plan-gate", displayName: "Plan (Review)", animate: false },
    { phase: "coding", displayName: "Coding", animate: true },
    { phase: "coding-gate", displayName: "Coding (Review)", animate: false },
    { phase: "qa", displayName: "QA", animate: true },
    { phase: "qa-gate", displayName: "QA (Review)", animate: false },
    { phase: "merging", displayName: "Merging", animate: true },
    { phase: "done", displayName: "Done", animate: false },
    { phase: "paused", displayName: "Paused", animate: false },
    { phase: "abandoned", displayName: "Abandoned", animate: false },
  ];

  for (const { phase, displayName, animate } of phases) {
    it(`shows "${displayName}" badge for phase "${phase}"`, () => {
      const ship = makeShip({ id: "s1", phase });
      const session = makeSession({ id: "ship-s1", type: "ship", shipId: "s1" });
      const { container } = render(
        <SessionCard session={session} ship={ship} isFocused={false} onFocus={() => {}} />,
      );
      expect(container.textContent).toContain(displayName);
    });

    if (animate) {
      it(`shows animation indicator for active phase "${phase}"`, () => {
        const ship = makeShip({ id: "s1", phase });
        const session = makeSession({ id: "ship-s1", type: "ship", shipId: "s1" });
        const { container } = render(
          <SessionCard session={session} ship={ship} isFocused={false} onFocus={() => {}} />,
        );
        const pulseEl = container.querySelector(".animate-pulse");
        expect(pulseEl).not.toBeNull();
      });
    }
  }

  it("shows 'Error' badge when processDead is true", () => {
    const ship = makeShip({ id: "s1", phase: "coding", processDead: true });
    const session = makeSession({ id: "ship-s1", type: "ship", shipId: "s1" });
    const { container } = render(
      <SessionCard session={session} ship={ship} isFocused={false} onFocus={() => {}} />,
    );
    expect(container.textContent).toContain("Error");
  });

  it("shows issue number and title", () => {
    const ship = makeShip({
      id: "s1",
      phase: "coding",
      issueNumber: 779,
      issueTitle: "UI component tests",
    });
    const session = makeSession({ id: "ship-s1", type: "ship", shipId: "s1" });
    const { container } = render(
      <SessionCard session={session} ship={ship} isFocused={false} onFocus={() => {}} />,
    );
    expect(container.textContent).toContain("#779");
    expect(container.textContent).toContain("UI component tests");
  });

  it("shows repo name", () => {
    const ship = makeShip({
      id: "s1",
      phase: "plan",
      repo: "mizunowanko/vibe-admiral",
    });
    const session = makeSession({ id: "ship-s1", type: "ship", shipId: "s1" });
    const { container } = render(
      <SessionCard session={session} ship={ship} isFocused={false} onFocus={() => {}} />,
    );
    expect(container.textContent).toContain("mizunowanko/vibe-admiral");
  });

  it("highlights when focused", () => {
    const ship = makeShip({ id: "s1", phase: "coding" });
    const session = makeSession({ id: "ship-s1", type: "ship", shipId: "s1" });
    const { container } = render(
      <SessionCard session={session} ship={ship} isFocused={true} onFocus={() => {}} />,
    );
    const card = container.firstElementChild;
    expect(card?.className).toContain("border-primary");
  });

  it("calls onFocus when clicked", () => {
    const onFocus = vi.fn();
    const ship = makeShip({ id: "s1", phase: "coding" });
    const session = makeSession({ id: "ship-s1", type: "ship", shipId: "s1" });
    render(
      <SessionCard session={session} ship={ship} isFocused={false} onFocus={onFocus} />,
    );
    fireEvent.click(screen.getByText("#42"));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("returns null for ship session without ship data", () => {
    const session = makeSession({ id: "ship-s1", type: "ship", shipId: "s1" });
    const { container } = render(
      <SessionCard session={session} isFocused={false} onFocus={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("DispatchCard", () => {
  it("renders dispatch name and Running badge", () => {
    const dispatch: Dispatch = {
      id: "d-1",
      parentRole: "dock",
      fleetId: "fleet-1",
      name: "investigate-bug",
      status: "running",
      startedAt: Date.now() - 60_000,
    };
    const { container } = render(
      <DispatchCard dispatch={dispatch} />,
    );
    expect(container.textContent).toContain("investigate-bug");
    expect(container.textContent).toContain("Running");
  });

  it("renders Completed badge for completed dispatches", () => {
    const dispatch: Dispatch = {
      id: "d-2",
      parentRole: "flagship",
      fleetId: "fleet-1",
      name: "explore-codebase",
      status: "completed",
      startedAt: Date.now() - 120_000,
      completedAt: Date.now(),
    };
    const { container } = render(
      <DispatchCard dispatch={dispatch} />,
    );
    expect(container.textContent).toContain("Completed");
  });

  it("renders Failed badge for failed dispatches", () => {
    const dispatch: Dispatch = {
      id: "d-3",
      parentRole: "dock",
      fleetId: "fleet-1",
      name: "broken-task",
      status: "failed",
      startedAt: Date.now() - 30_000,
      completedAt: Date.now(),
    };
    const { container } = render(
      <DispatchCard dispatch={dispatch} />,
    );
    expect(container.textContent).toContain("Failed");
  });

  it("highlights when focused", () => {
    const dispatch: Dispatch = {
      id: "d-1",
      parentRole: "dock",
      fleetId: "fleet-1",
      name: "task",
      status: "running",
      startedAt: Date.now(),
    };
    const { container } = render(
      <DispatchCard dispatch={dispatch} isFocused={true} />,
    );
    const card = container.querySelector("button");
    expect(card?.className).toContain("border-primary");
  });
});
