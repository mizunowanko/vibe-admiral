/**
 * SessionChat — message display pipeline and thinking state tests.
 *
 * Guards against regressions during #774 and #778:
 * - Messages display in correct context (ship vs command)
 * - Thinking state (isLoading) is session-specific
 * - Empty state shows appropriate message per session type
 * - Disconnected/rate-limit banners appear correctly
 *
 * NOTE: SessionChat depends on useSessionMessages which uses useCommander
 * (WebSocket-dependent). We mock useSessionMessages to focus on the
 * rendering pipeline.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionChat } from "./SessionChat";
import { resetAllStores, makeMessage, makeSession, makeShip, seedSessions, seedShips, seedShipLogs } from "@/test-utils/store-helpers";
import { useUIStore } from "@/stores/uiStore";
import { useFleetStore } from "@/stores/fleetStore";
import type { StreamMessage, Session } from "@/types";

// Mock react-markdown
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("@/lib/remark-issue-link", () => ({ remarkIssueLink: () => {} }));

// We mock useSessionMessages to control the data pipeline directly
const mockUseSessionMessages = vi.fn();
vi.mock("@/hooks/useSessionMessages", () => ({
  useSessionMessages: (...args: unknown[]) => mockUseSessionMessages(...args),
}));

// Mock useShip to return null for non-ship sessions
vi.mock("@/hooks/useShip", () => ({
  useShip: () => ({ ship: null, logs: [] }),
}));

beforeEach(() => {
  resetAllStores();
  useFleetStore.setState({
    fleets: [{ id: "f1", name: "Test", repos: [], createdAt: "" }],
    selectedFleetId: "f1",
    selectedFleet: { id: "f1", name: "Test", repos: [], createdAt: "" },
  });
  useUIStore.setState({ engineConnected: true, rateLimitActive: false });
  mockUseSessionMessages.mockReset();
});

function mockSession(session: Session, messages: StreamMessage[], isLoading = false) {
  mockUseSessionMessages.mockReturnValue({
    messages,
    sendMessage: session.hasInput ? vi.fn() : undefined,
    isLoading,
    session,
  });
}

describe("SessionChat empty states", () => {
  it("shows 'Select a session' when no sessionId", () => {
    mockUseSessionMessages.mockReturnValue({
      messages: [],
      isLoading: false,
      session: null,
    });

    render(<SessionChat sessionId={null} />);
    expect(screen.getByText("Select a session")).toBeInTheDocument();
  });

  it("shows Dock empty message for dock session", () => {
    const dock = makeSession({ id: "dock-f1", type: "dock", fleetId: "f1" });
    mockSession(dock, []);

    render(<SessionChat sessionId="dock-f1" />);
    expect(screen.getByText("Dock is ready. Send a command to manage issues.")).toBeInTheDocument();
  });

  it("shows Flagship empty message for flagship session", () => {
    const flagship = makeSession({ id: "flagship-f1", type: "flagship", fleetId: "f1" });
    mockSession(flagship, []);

    render(<SessionChat sessionId="flagship-f1" />);
    expect(screen.getByText("Flagship is ready. Send a command to manage ships.")).toBeInTheDocument();
  });

  it("shows Ship empty message for ship session", () => {
    const ship = makeSession({ id: "ship-s1", type: "ship", shipId: "s1", fleetId: "f1" });
    mockSession(ship, []);

    render(<SessionChat sessionId="ship-s1" />);
    expect(screen.getByText("Waiting for output...")).toBeInTheDocument();
  });
});

describe("SessionChat thinking state isolation", () => {
  it("shows 'Dock is thinking...' only for Dock session", () => {
    const dock = makeSession({ id: "dock-f1", type: "dock", fleetId: "f1" });
    mockSession(dock, [
      makeMessage({ type: "user", content: "list issues" }),
    ], true);

    render(<SessionChat sessionId="dock-f1" />);
    expect(screen.getByText("Dock is thinking...")).toBeInTheDocument();
  });

  it("shows 'Flagship is thinking...' only for Flagship session", () => {
    const flagship = makeSession({ id: "flagship-f1", type: "flagship", fleetId: "f1" });
    mockSession(flagship, [
      makeMessage({ type: "user", content: "sortie #42" }),
    ], true);

    render(<SessionChat sessionId="flagship-f1" />);
    expect(screen.getByText("Flagship is thinking...")).toBeInTheDocument();
  });

  it("does not show thinking indicator when not loading", () => {
    const dock = makeSession({ id: "dock-f1", type: "dock", fleetId: "f1" });
    mockSession(dock, [
      makeMessage({ type: "assistant", content: "Here are the issues" }),
    ], false);

    render(<SessionChat sessionId="dock-f1" />);
    expect(screen.queryByText(/is thinking/)).not.toBeInTheDocument();
  });
});

describe("SessionChat disconnected/rate-limit banners", () => {
  it("shows disconnected banner when engine is disconnected", () => {
    useUIStore.setState({ engineConnected: false });
    const dock = makeSession({ id: "dock-f1", type: "dock", fleetId: "f1" });
    mockSession(dock, []);

    render(<SessionChat sessionId="dock-f1" />);
    expect(screen.getByText(/Engine disconnected/)).toBeInTheDocument();
  });

  it("shows rate limit banner when rate limit is active", () => {
    useUIStore.setState({ rateLimitActive: true });
    const dock = makeSession({ id: "dock-f1", type: "dock", fleetId: "f1" });
    mockSession(dock, []);

    render(<SessionChat sessionId="dock-f1" />);
    expect(screen.getByText(/rate limit/i)).toBeInTheDocument();
  });

  it("does not show rate limit banner when engine is disconnected", () => {
    useUIStore.setState({ engineConnected: false, rateLimitActive: true });
    const dock = makeSession({ id: "dock-f1", type: "dock", fleetId: "f1" });
    mockSession(dock, []);

    render(<SessionChat sessionId="dock-f1" />);
    // Rate limit banner is conditional on engineConnected
    expect(screen.queryByText(/rate limit/i)).not.toBeInTheDocument();
  });
});

describe("SessionChat renders input only for sessions with input", () => {
  it("renders input for Dock session", () => {
    const dock = makeSession({ id: "dock-f1", type: "dock", fleetId: "f1", hasInput: true });
    mockSession(dock, []);

    render(<SessionChat sessionId="dock-f1" />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("does not render input for Ship session", () => {
    const ship = makeSession({ id: "ship-s1", type: "ship", shipId: "s1", fleetId: "f1", hasInput: false });
    mockSession(ship, []);

    render(<SessionChat sessionId="ship-s1" />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
