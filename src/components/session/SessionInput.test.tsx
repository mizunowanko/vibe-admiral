/**
 * SessionInput — draft persistence and input independence tests.
 *
 * Guards against regressions during #778 (store normalization):
 * - Dock and Flagship input drafts are independent (stored by sessionId)
 * - Draft persists across session switches (simulated by rerender with new sessionId)
 * - Send clears the draft
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionInput } from "./SessionInput";
import { resetAllStores, seedInputDrafts } from "@/test-utils/store-helpers";
import { useSessionStore } from "@/stores/sessionStore";

beforeEach(() => {
  resetAllStores();
});

describe("SessionInput draft persistence", () => {
  it("shows stored draft when mounting with a sessionId", () => {
    seedInputDrafts({ "dock-fleet-1": "hello dock" });

    render(
      <SessionInput
        onSend={() => {}}
        sessionId="dock-fleet-1"
        placeholder="Type..."
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello dock");
  });

  it("persists typed text to session store", () => {
    render(
      <SessionInput
        onSend={() => {}}
        sessionId="dock-fleet-1"
        placeholder="Type..."
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "new draft" } });

    expect(useSessionStore.getState().inputDrafts["dock-fleet-1"]).toBe("new draft");
  });

  it("stores drafts independently per session", () => {
    // Pre-fill dock draft
    seedInputDrafts({ "dock-fleet-1": "dock message" });

    // Mount with dock session
    const { rerender } = render(
      <SessionInput
        onSend={() => {}}
        sessionId="dock-fleet-1"
        placeholder="Type..."
      />,
    );

    // Switch to flagship session
    rerender(
      <SessionInput
        onSend={() => {}}
        sessionId="flagship-fleet-1"
        placeholder="Type..."
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe(""); // Flagship has no draft yet

    // Type in flagship
    fireEvent.change(textarea, { target: { value: "flagship message" } });

    // Both drafts exist independently
    const drafts = useSessionStore.getState().inputDrafts;
    expect(drafts["dock-fleet-1"]).toBe("dock message");
    expect(drafts["flagship-fleet-1"]).toBe("flagship message");
  });

  it("restores draft when switching back to a session", () => {
    seedInputDrafts({
      "dock-fleet-1": "dock draft",
      "flagship-fleet-1": "flagship draft",
    });

    // Start with dock
    const { rerender } = render(
      <SessionInput
        onSend={() => {}}
        sessionId="dock-fleet-1"
        placeholder="Type..."
      />,
    );

    let textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("dock draft");

    // Switch to flagship
    rerender(
      <SessionInput
        onSend={() => {}}
        sessionId="flagship-fleet-1"
        placeholder="Type..."
      />,
    );

    textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("flagship draft");

    // Switch back to dock
    rerender(
      <SessionInput
        onSend={() => {}}
        sessionId="dock-fleet-1"
        placeholder="Type..."
      />,
    );

    textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("dock draft");
  });
});

describe("SessionInput send behavior", () => {
  it("calls onSend with trimmed text and clears draft", () => {
    const onSend = vi.fn();
    render(
      <SessionInput
        onSend={onSend}
        sessionId="dock-fleet-1"
        placeholder="Type..."
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "  send this  " } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSend).toHaveBeenCalledWith("send this", undefined);
    expect((textarea as HTMLTextAreaElement).value).toBe("");
    expect(useSessionStore.getState().inputDrafts["dock-fleet-1"]).toBe("");
  });

  it("does not send empty messages", () => {
    const onSend = vi.fn();
    render(
      <SessionInput
        onSend={onSend}
        sessionId="dock-fleet-1"
        placeholder="Type..."
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("allows newline with Shift+Enter", () => {
    const onSend = vi.fn();
    render(
      <SessionInput
        onSend={onSend}
        sessionId="dock-fleet-1"
        placeholder="Type..."
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables send when disabled prop is true", () => {
    render(
      <SessionInput
        onSend={() => {}}
        disabled={true}
        sessionId="dock-fleet-1"
        placeholder="Engine disconnected"
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });
});
