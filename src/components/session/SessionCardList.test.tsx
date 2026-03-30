/**
 * SessionCardList — section separation and filtering tests.
 *
 * Guards against regressions during #778 (store normalization):
 * - Commander (Dock/Flagship), Dispatch, and Ship sections render correctly
 * - Ship filtering: active vs inactive (done/paused/abandoned/processDead)
 * - Focus management: clicking a card calls setFocus with correct session ID
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionCardList } from "./SessionCardList";
import {
  resetAllStores,
  seedSessions,
  seedShips,
  seedDispatches,
  makeShip,
  makeSession,
} from "@/test-utils/store-helpers";
import { useSessionStore } from "@/stores/sessionStore";

// Mock the dispatch listener hook (depends on wsClient)
vi.mock("@/hooks/useDispatchListener", () => ({
  useDispatchListener: () => {},
}));

// Mock ActiveShipSummary to avoid deep render tree
vi.mock("@/components/ship/ActiveShipSummary", () => ({
  ActiveShipSummary: () => <span data-testid="active-ship-summary" />,
}));

const FLEET_ID = "fleet-1";

beforeEach(() => {
  resetAllStores();
});

describe("SessionCardList section separation", () => {
  it("renders Dock and Flagship sections when both sessions exist", () => {
    seedSessions([
      makeSession({ id: `dock-${FLEET_ID}`, type: "dock", fleetId: FLEET_ID }),
      makeSession({ id: `flagship-${FLEET_ID}`, type: "flagship", fleetId: FLEET_ID }),
    ]);

    render(<SessionCardList fleetId={FLEET_ID} />);

    // Section headers are uppercase h3 elements
    const headers = screen.getAllByRole("heading", { level: 3 });
    const headerTexts = headers.map((h) => h.textContent);
    expect(headerTexts).toContain("Dock");
    expect(headerTexts).toContain("Flagship");
  });

  it("renders Ships section header", () => {
    seedSessions([
      makeSession({ id: `dock-${FLEET_ID}`, type: "dock", fleetId: FLEET_ID }),
    ]);

    render(<SessionCardList fleetId={FLEET_ID} />);

    expect(screen.getByText("Ships")).toBeInTheDocument();
  });

  it("shows 'No active ships' when no ships exist", () => {
    seedSessions([
      makeSession({ id: `dock-${FLEET_ID}`, type: "dock", fleetId: FLEET_ID }),
    ]);

    render(<SessionCardList fleetId={FLEET_ID} />);

    expect(screen.getByText("No active ships")).toBeInTheDocument();
  });

  it("renders Dispatches section when dispatches exist", () => {
    seedSessions([
      makeSession({ id: `dock-${FLEET_ID}`, type: "dock", fleetId: FLEET_ID }),
    ]);
    seedDispatches([
      {
        id: "d-1",
        parentRole: "dock",
        fleetId: FLEET_ID,
        name: "investigate",
        status: "running",
        startedAt: Date.now(),
      },
    ]);

    render(<SessionCardList fleetId={FLEET_ID} />);

    expect(screen.getByText("Dispatches")).toBeInTheDocument();
    expect(screen.getByText("investigate")).toBeInTheDocument();
  });
});

describe("SessionCardList ship filtering", () => {
  function setupShips() {
    const activeShip = makeShip({
      id: "s-active",
      phase: "coding",
      fleetId: FLEET_ID,
      issueNumber: 1,
      issueTitle: "Active ship",
    });
    const doneShip = makeShip({
      id: "s-done",
      phase: "done",
      fleetId: FLEET_ID,
      issueNumber: 2,
      issueTitle: "Done ship",
    });
    const pausedShip = makeShip({
      id: "s-paused",
      phase: "paused",
      fleetId: FLEET_ID,
      issueNumber: 3,
      issueTitle: "Paused ship",
    });
    const abandonedShip = makeShip({
      id: "s-abandoned",
      phase: "abandoned",
      fleetId: FLEET_ID,
      issueNumber: 4,
      issueTitle: "Abandoned ship",
    });
    const deadShip = makeShip({
      id: "s-dead",
      phase: "coding",
      processDead: true,
      fleetId: FLEET_ID,
      issueNumber: 5,
      issueTitle: "Dead ship",
    });

    seedShips([activeShip, doneShip, pausedShip, abandonedShip, deadShip]);
    seedSessions([
      makeSession({ id: `dock-${FLEET_ID}`, type: "dock", fleetId: FLEET_ID }),
      makeSession({ id: "ship-s-active", type: "ship", shipId: "s-active", fleetId: FLEET_ID }),
      makeSession({ id: "ship-s-done", type: "ship", shipId: "s-done", fleetId: FLEET_ID }),
      makeSession({ id: "ship-s-paused", type: "ship", shipId: "s-paused", fleetId: FLEET_ID }),
      makeSession({ id: "ship-s-abandoned", type: "ship", shipId: "s-abandoned", fleetId: FLEET_ID }),
      makeSession({ id: "ship-s-dead", type: "ship", shipId: "s-dead", fleetId: FLEET_ID }),
    ]);
  }

  it("shows only active ships by default", () => {
    setupShips();
    render(<SessionCardList fleetId={FLEET_ID} />);

    expect(screen.getByText("1 ship")).toBeInTheDocument();
    expect(screen.getByText("Active ship")).toBeInTheDocument();
    expect(screen.queryByText("Done ship")).not.toBeInTheDocument();
    expect(screen.queryByText("Paused ship")).not.toBeInTheDocument();
    expect(screen.queryByText("Abandoned ship")).not.toBeInTheDocument();
    expect(screen.queryByText("Dead ship")).not.toBeInTheDocument();
  });

  it("shows all ships when 'Show inactive' is toggled", () => {
    setupShips();
    render(<SessionCardList fleetId={FLEET_ID} />);

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);

    expect(screen.getByText("5 ships")).toBeInTheDocument();
    expect(screen.getByText("Active ship")).toBeInTheDocument();
    expect(screen.getByText("Done ship")).toBeInTheDocument();
    expect(screen.getByText("Paused ship")).toBeInTheDocument();
    expect(screen.getByText("Abandoned ship")).toBeInTheDocument();
    expect(screen.getByText("Dead ship")).toBeInTheDocument();
  });
});

describe("SessionCardList focus management", () => {
  it("clicking a Commander card sets focus to that session", () => {
    seedSessions([
      makeSession({ id: `dock-${FLEET_ID}`, type: "dock", fleetId: FLEET_ID }),
      makeSession({ id: `flagship-${FLEET_ID}`, type: "flagship", fleetId: FLEET_ID }),
    ]);

    render(<SessionCardList fleetId={FLEET_ID} />);

    // Click on Flagship card (it's a button with text "Flagship")
    const flagshipButton = screen.getAllByRole("button").find(
      (btn) => btn.textContent?.includes("Ship management"),
    );
    expect(flagshipButton).toBeDefined();
    fireEvent.click(flagshipButton!);

    expect(useSessionStore.getState().focusedSessionId).toBe(`flagship-${FLEET_ID}`);
  });

  it("clicking a Ship card sets focus to that ship session", () => {
    const ship = makeShip({
      id: "s1",
      phase: "coding",
      fleetId: FLEET_ID,
      issueNumber: 42,
      issueTitle: "Test issue",
    });
    seedShips([ship]);
    seedSessions([
      makeSession({ id: `dock-${FLEET_ID}`, type: "dock", fleetId: FLEET_ID }),
      makeSession({ id: "ship-s1", type: "ship", shipId: "s1", fleetId: FLEET_ID }),
    ]);

    render(<SessionCardList fleetId={FLEET_ID} />);

    fireEvent.click(screen.getByText("Test issue"));

    expect(useSessionStore.getState().focusedSessionId).toBe("ship-s1");
  });
});
