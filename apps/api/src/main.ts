import "reflect-metadata";
import { createApp } from "./app";
import { loadEnv } from "./env";
import { createInfra } from "./infra/infra";

async function main(): Promise<void> {
  const env = loadEnv();
  const infra = createInfra(env);
  const app = await createApp(env, infra);
  await app.listen(env.API_PORT, "0.0.0.0");
  infra.logger.info({ port: env.API_PORT }, "api started");

  // Finish the requests that are running, then leave with code 0.
  // (Nest's own shutdown hooks would end the process with the signal's code, 143, instead of 0.)
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    infra.logger.info({ signal }, "shutting down: finishing running requests");
    // No new requests are accepted; idle keep-alive connections are closed so they do not hold the shutdown.
    app.getHttpServer().closeIdleConnections();
    // A request that never ends must not keep the process alive for ever.
    setTimeout(() => process.exit(1), 15_000).unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("api failed to start", error);
  process.exit(1);
});
