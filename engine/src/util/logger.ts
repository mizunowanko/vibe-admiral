type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  return " " + JSON.stringify(meta);
}

function createLogger(prefixes: string[], minLevel: LogLevel): Logger {
  const tag = prefixes.map((p) => `[${p}]`).join("");
  const minPriority = LEVEL_PRIORITY[minLevel];

  function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;
    const ts = new Date().toISOString();
    const line = `${ts} ${tag} ${msg}${formatMeta(meta)}`;
    switch (level) {
      case "error":
        console.error(line);
        break;
      case "warn":
        console.warn(line);
        break;
      default:
        console.log(line);
        break;
    }
  }

  return {
    debug: (msg, meta) => log("debug", msg, meta),
    info: (msg, meta) => log("info", msg, meta),
    warn: (msg, meta) => log("warn", msg, meta),
    error: (msg, meta) => log("error", msg, meta),
    child(prefix: string): Logger {
      return createLogger([...prefixes, prefix], minLevel);
    },
  };
}

export const logger: Logger = createLogger(
  ["engine"],
  (process.env.LOG_LEVEL as LogLevel) ?? "info",
);
