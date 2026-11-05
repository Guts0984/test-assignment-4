import { loadEnv } from "./env";
import { createLogger } from "./logger";
import { startWorker } from "./worker";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const worker = await startWorker(env, logger);
  logger.info({ healthPort: worker.healthPort }, "worker started");

  // Finish the job that is running, then leave with code 0.
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down: finishing the running job");
    setTimeout(() => process.exit(1), 20_000).unref();
    worker.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("worker failed to start", error);
  process.exit(1);
});
