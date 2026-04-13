import type { ChildProcess } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { safeJsonParse } from "./util/json-safe.js";

const RETRYABLE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
  /overloaded/i,
  /rate_limit_error/i,
  /APIError.*429/i,
  /\b529\b/,
  /\b500\b/,
  /\b401\b/,
  /internal.?server.?error/i,
  /service.?unavailable/i,
];

export function isRetryableError(text: string): boolean {
  return RETRYABLE_ERROR_PATTERNS.some((p) => p.test(text));
}

/** @deprecated Use isRetryableError instead. Kept for backward compatibility. */
export const isRateLimitError = isRetryableError;

export interface StreamCallbacks {
  onMessage: (msg: Record<string, unknown>) => void;
  onRetryableError: () => void;
  onError: (error: Error) => void;
}

export function attachStdoutProcessor(
  proc: ChildProcess,
  shortId: string,
  logFilePath: string | undefined,
  callbacks: StreamCallbacks,
): void {
  let buffer = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = safeJsonParse<Record<string, unknown>>(line, { source: `proc:${shortId}.stdout` });
      if (!msg) continue;
      callbacks.onMessage(msg);

      if (logFilePath && !(msg.type === "system" && msg.subtype === "init")) {
        const msgWithTs = { ...msg, timestamp: Date.now() };
        appendFile(logFilePath, JSON.stringify(msgWithTs) + "\n").catch(() => {});
      }
    }
  });
}

export function attachStderrProcessor(
  proc: ChildProcess,
  shortId: string,
  callbacks: StreamCallbacks,
): void {
  let stderrBuffer = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      console.error(`[proc:${shortId}] stderr: ${text.slice(0, 200)}`);
      if (isRetryableError(text)) {
        callbacks.onRetryableError();
      } else {
        callbacks.onError(new Error(text));
      }
    }
  });
}
