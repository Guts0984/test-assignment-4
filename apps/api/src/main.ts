import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadEnv } from "./env";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  await app.listen(env.API_PORT, "0.0.0.0");

  // Finish the requests that are running, then leave with code 0.
  // (Nest's own shutdown hooks would end the process with the signal's code, 143, instead of 0.)
  const stop = (): void => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main();
