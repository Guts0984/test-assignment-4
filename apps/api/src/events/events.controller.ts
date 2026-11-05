import {
  eventListQuerySchema,
  eventListSchema,
  eventSchema,
  parseEventId,
  patchEventBodySchema,
  type EventDto,
  type EventList,
  type EventListQuery,
  type PatchEventBody,
} from "@app/shared";
import { Body, Controller, Get, Inject, Param, Patch, Query } from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Auth } from "../auth/auth.guard";
import { notFound } from "../http/errors";
import { openApiSchema } from "../http/openapi";
import { ZodPipe } from "../http/zod-pipe";
import { EventsService } from "./events.service";

@ApiTags("events")
@Controller("events")
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}

  @Get()
  @ApiOperation({ summary: "Upcoming events (filters, title search, cursor pagination). Past events are not listed." })
  @ApiOkResponse({ schema: openApiSchema(eventListSchema, "output") })
  list(@Query(new ZodPipe(eventListQuerySchema)) query: EventListQuery): Promise<EventList> {
    return this.events.listEvents(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "One event. 404 when there is no such event (also for ids that are not numbers)." })
  @ApiParam({ name: "id", type: "string" })
  @ApiOkResponse({ schema: openApiSchema(eventSchema, "output") })
  async one(@Param("id") rawId: string): Promise<EventDto> {
    const id = parseEventId(rawId);
    if (id === null) throw notFound("Event not found");
    const event = await this.events.getEvent(id);
    if (!event) throw notFound("Event not found");
    return event;
  }

  @Patch(":id")
  @Auth("admin")
  @ApiOperation({ summary: "Change title and/or description (admin only). 409 with the saved event when `version` is stale." })
  @ApiParam({ name: "id", type: "string" })
  @ApiBody({ schema: openApiSchema(patchEventBodySchema) })
  @ApiOkResponse({ schema: openApiSchema(eventSchema, "output") })
  @ApiResponse({ status: 409, description: "VERSION_CONFLICT: details.current is the saved event" })
  async patch(@Param("id") rawId: string, @Body(new ZodPipe(patchEventBodySchema)) body: PatchEventBody): Promise<EventDto> {
    const id = parseEventId(rawId);
    if (id === null) throw notFound("Event not found");
    return this.events.patchEvent(id, body);
  }
}
