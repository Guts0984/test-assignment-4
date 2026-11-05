import { ErrorCode } from "@app/shared";
import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Infra, withTimeout } from "./infra/infra";

@ApiTags("health")
@Controller()
export class HealthController {
  constructor(@Inject(Infra) private readonly infra: Infra) {}

  /** The process is alive (Docker's health check asks this). It touches nothing else, so it never fails because of a dependency. */
  @Get("health")
  @ApiOperation({ summary: "Is the process alive?" })
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  /** The service can do its work: PostgreSQL and Redis both answer within 2 seconds. */
  @Get("ready")
  @ApiOperation({ summary: "Are PostgreSQL and Redis reachable?" })
  async ready(@Res({ passthrough: true }) res: Response): Promise<unknown> {
    const check = (work: Promise<unknown>, what: string): Promise<"up" | "down"> =>
      withTimeout(work, 2000, what).then(
        () => "up" as const,
        () => "down" as const,
      );
    const [postgres, redis] = await Promise.all([
      check(this.infra.db.$queryRaw`SELECT 1`, "postgres"),
      check(this.infra.redis.ping(), "redis"),
    ]);
    if (postgres === "up" && redis === "up") return { status: "ready", postgres, redis };
    res.status(503).setHeader("Retry-After", "2");
    return { code: ErrorCode.NOT_READY, message: "A dependency is not reachable.", details: { postgres, redis } };
  }
}
