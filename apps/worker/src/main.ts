import http from "node:http";
import { loadEnv } from "./env";
import { createLogger } from "./logger";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

// For Docker's health check.
const health = http.createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
});
health.listen(env.HEALTH_PORT, () => logger.info({ healthPort: env.HEALTH_PORT }, "worker started"));

const stop = (signal: string): void => {
  logger.info({ signal }, "signal received");
  health.close(() => process.exit(0));
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
