import {
  createHoldBodySchema,
  holdSchema,
  idempotencyKeySchema,
  IDEMPOTENCY_KEY_HEADER,
  orderListSchema,
  orderSchema,
  parseEventId,
  seatMapSchema,
  type CreateHoldBody,
  type HoldDto,
  type OrderDto,
  type OrderList,
  type SeatMap,
} from "@app/shared";
import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Auth } from "../auth/auth.guard";
import { OptionalAuth } from "../auth/optional-auth.guard";
import { notFound, validationError } from "../http/errors";
import { openApiSchema } from "../http/openapi";
import { ZodPipe } from "../http/zod-pipe";
import { Infra } from "../infra/infra";
import { requestHash, runOnce } from "./idempotency";
import { SeatsService } from "./seats.service";

/** The logged-in user of this request (the guard has already made sure there is one). */
function userIdOf(req: Request): string {
  if (!req.session) throw new Error("session missing after AuthGuard");
  return req.session.userId;
}

@ApiTags("seats and holds")
@Controller()
export class HoldsController {
  constructor(
    @Inject(SeatsService) private readonly seats: SeatsService,
    @Inject(Infra) private readonly infra: Infra,
  ) {}

  @Get("events/:id/seats")
  @OptionalAuth()
  // Seat state must be fresh: no cache between the api and the visitor, whatever their address.
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "The hall of an event: which seats are free, held or sold. `mine` marks the caller's own seats." })
  @ApiParam({ name: "id", type: "string" })
  @ApiOkResponse({ schema: openApiSchema(seatMapSchema, "output") })
  async seatMap(@Param("id") rawId: string, @Req() req: Request): Promise<SeatMap> {
    const eventId = parseEventId(rawId);
    if (eventId === null) throw notFound("Event not found");
    return this.seats.seatMap(eventId, req.session?.userId);
  }

  @Post("events/:id/holds")
  @Auth()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Hold 1-6 seats for 10 minutes. Needs an Idempotency-Key header; repeating the key returns the same answer." })
  @ApiHeader({ name: "Idempotency-Key", required: true, description: "8-128 characters; generate a new one for each new attempt" })
  @ApiParam({ name: "id", type: "string" })
  @ApiBody({ schema: openApiSchema(createHoldBodySchema) })
  @ApiResponse({ status: 201, schema: openApiSchema(holdSchema, "output") })
  @ApiResponse({ status: 409, description: "SOLD_OUT (details.seatIds) or SEAT_LIMIT_REACHED" })
  @ApiResponse({ status: 422, description: "IDEMPOTENCY_KEY_REUSED: the key was used for a different request" })
  async createHold(
    @Param("id") rawId: string,
    @Headers(IDEMPOTENCY_KEY_HEADER) rawKey: string | undefined,
    @Body(new ZodPipe(createHoldBodySchema)) body: CreateHoldBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ hold: HoldDto }> {
    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) {
      throw validationError({ "Idempotency-Key": [rawKey === undefined ? "The Idempotency-Key header is required." : "Use 8 to 128 letters, digits and . _ : -"] });
    }
    const eventId = parseEventId(rawId);
    if (eventId === null) throw notFound("Event not found");
    const userId = userIdOf(req);
    // The same seats in another order are the same request.
    const hash = requestHash({ op: "hold", eventId, seatIds: [...body.seatIds].sort((a, b) => a - b) });
    const result = await runOnce(this.infra, userId, key.data, hash, async () => ({
      status: 201,
      body: { hold: await this.seats.createHold(userId, eventId, body.seatIds) },
    }));
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.status);
    return result.body as { hold: HoldDto };
  }

  @Get("holds/:id")
  @Auth()
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "One of your own bookings (for the payment page)" })
  @ApiOkResponse({ schema: openApiSchema(holdSchema, "output") })
  async hold(@Param("id") id: string, @Req() req: Request): Promise<{ hold: HoldDto }> {
    return { hold: await this.seats.readHold(userIdOf(req), id) };
  }

  @Post("holds/:id/pay")
  @Auth()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Pay (a stub that always succeeds): the hold becomes an order. Paying twice returns the same order." })
  @ApiOkResponse({ schema: openApiSchema(orderSchema, "output") })
  @ApiResponse({ status: 409, description: "BOOKING_EXPIRED or BOOKING_CANCELLED" })
  async pay(@Param("id") id: string, @Req() req: Request): Promise<{ order: OrderDto }> {
    return { order: await this.seats.payHold(userIdOf(req), id) };
  }

  @Delete("holds/:id")
  @Auth()
  @HttpCode(204)
  @ApiOperation({ summary: "Give the seats back. Repeating it is fine." })
  @ApiResponse({ status: 409, description: "ALREADY_PAID" })
  async cancel(@Param("id") id: string, @Req() req: Request): Promise<void> {
    await this.seats.cancelHold(userIdOf(req), id);
  }

  @Get("me/orders")
  @Auth()
  // Private to one user: no shared cache (nginx, a CDN, Next.js) may ever keep this.
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "The caller's own orders, newest first" })
  @ApiOkResponse({ schema: openApiSchema(orderListSchema, "output") })
  orders(@Req() req: Request): Promise<OrderList> {
    return this.seats.listOrders(userIdOf(req));
  }
}

