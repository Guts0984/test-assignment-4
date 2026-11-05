import { type DynamicModule, Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthController } from "./auth/auth.controller";
import { AuthGuard } from "./auth/auth.guard";
import { AuthService } from "./auth/auth.service";
import { OptionalAuthGuard } from "./auth/optional-auth.guard";
import { SessionStore } from "./auth/session";
import { EventsController } from "./events/events.controller";
import { EventsService } from "./events/events.service";
import { HealthController } from "./health.controller";
import { HoldsController } from "./holds/holds.controller";
import { SeatsService } from "./holds/seats.service";
import { RateLimiter } from "./http/rate-limiter";
import { Infra } from "./infra/infra";
import { Realtime } from "./realtime/realtime";

@Module({})
export class AppModule {
  /** `infra` (database, Redis, logger, settings) and `realtime` are created by the caller so the process and the tests build them the same way. */
  static forRoot(infra: Infra, realtime: Realtime): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, EventsController, HoldsController],
      providers: [
        { provide: Infra, useValue: infra },
        { provide: Realtime, useValue: realtime },
        { provide: RateLimiter, useFactory: () => new RateLimiter(infra.redis, infra.logger) },
        { provide: SessionStore, useFactory: () => new SessionStore(infra.redis, infra.env.SESSION_TTL_SECONDS) },
        AuthService,
        AuthGuard,
        OptionalAuthGuard,
        EventsService,
        SeatsService,
        Reflector,
      ],
    };
  }
}
