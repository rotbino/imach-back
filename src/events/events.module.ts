import { Global, Module } from "@nestjs/common";
import { ListingEventsService } from "./listing-events.service";

/** M10 — ماژول سراسری نویسندهٔ ListingEventLog (استفاده در market/listings/chat/promos) */
@Global()
@Module({
  providers: [ListingEventsService],
  exports: [ListingEventsService],
})
export class EventsModule {}
