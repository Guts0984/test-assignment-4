import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { parseTrustProxy } from "./http/client-ip";
import { ApiExceptionFilter } from "./http/errors";
import { rateLimit, rejectNulInUrl, requestContext } from "./http/middleware";
import { SessionStore } from "./auth/session";
import { SeatsService } from "./holds/seats.service";
import { RateLimiter } from "./http/rate-limiter";
import { Realtime } from "./realtime/realtime";
import { createInfra, waitForRedis, type Infra } from "./infra/infra";
import type { Env } from "./env";

/**
 * Builds the whole application (not yet listening). `main.ts` runs it; the tests build it the same way,
 * so what is tested is what runs.
 */
export async function createApp(env: Env, infra: Infra = createInfra(env)): Promise<NestExpressApplication> {
  await waitForRedis(infra.redis);
  const realtime = new Realtime(infra);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(infra, realtime), { logger: false });
  const { logger } = infra;

  app.disable("x-powered-by");
  app.set("trust proxy", parseTrustProxy(env.TRUST_PROXY));
  app.useBodyParser("json", { limit: "100kb" });

  // Order matters: the request id first (every later line uses it), then the cheap refusals, then the rate limit.
  app.use(requestContext(logger, env.INTERNAL_SECRET));
  app.use(rejectNulInUrl(logger));
  app.use(rateLimit(new RateLimiter(infra.redis, logger), logger, env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_SECONDS));
  app.useGlobalFilters(new ApiExceptionFilter(logger));

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Tickets API")
      .setDescription("Event tickets with seat selection. Errors always look like { code, message, details }.")
      .setVersion("1.0")
      .addCookieAuth("sid")
      .build(),
  );
  SwaggerModule.setup("docs", app, document, { jsonDocumentUrl: "openapi.json" });

  // Live seat updates (Socket.IO) share the http server and the session cookie of the normal requests.
  realtime.start(app.getHttpServer(), app.get(SessionStore), (eventId, userId) => app.get(SeatsService).seatMap(eventId, userId));

  // Closing the app also closes the live connections and the database / Redis connections (each is safe to close twice).
  const closeApp = app.close.bind(app);
  app.close = async () => {
    await realtime.close();
    await closeApp();
    await infra.onApplicationShutdown();
  };
  return app;
}
