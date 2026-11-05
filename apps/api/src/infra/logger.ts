import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/** JSON logs, one object per line. Every request log line carries the request id that nginx assigned. */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "api" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      // Never print credentials, whatever gets logged by mistake.
      redact: ["req.headers.cookie", "req.headers.authorization", "password", "*.password"],
    },
    destination,
  );
}
