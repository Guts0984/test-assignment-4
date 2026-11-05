import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  /** The process is alive (Docker's health check asks this). */
  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }
}
