import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/** JSON logs, one object per line. Jobs log through a child logger that carries their request id. */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "worker" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}
