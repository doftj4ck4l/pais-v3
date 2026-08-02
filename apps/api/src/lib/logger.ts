export type LogLevel = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const ORDER: LogLevel[] = ["debug", "info", "warn", "error"];
const THRESHOLD: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

function levelEnabled(level: LogLevel): boolean {
  return ORDER.indexOf(level) >= ORDER.indexOf(THRESHOLD);
}

/** Emit one structured line: `[ts] LEVEL label key=value key=value`. */
export function log(level: LogLevel, label: string, fields: Fields = {}): void {
  if (!levelEnabled(level)) return;
  const ts = new Date().toISOString().slice(11, 23);
  const color = COLORS[level];
  const parts = Object.entries(fields)
    .map(([k, v]) => {
      if (typeof v === "object") return `${k}=${JSON.stringify(v)}`;
      return `${k}=${v}`;
    })
    .join(" ");
  const line = `[${ts}] ${color}${level.toUpperCase()}\x1b[0m ${label}${parts ? ` ${color}${parts}${RESET}` : ""}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (label: string, fields?: Fields) => log("debug", label, fields),
  info: (label: string, fields?: Fields) => log("info", label, fields),
  warn: (label: string, fields?: Fields) => log("warn", label, fields),
  error: (label: string, fields?: Fields) => log("error", label, fields),
};

/** Timer helper: returns a function that logs an elapsed "x ms" span. */
export function startTimer() {
  const t0 = performance.now();
  return { elapsed: () => Math.round((performance.now() - t0) * 100) / 100 };
}
