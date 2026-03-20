/**
 * @file index.ts
 * @description Public API barrel export for @robert-sopenlehto/xceed-connector.
 * @rationale Single entry point keeps the consumer import surface clean and
 *   allows internal module reorganisation without breaking consumer imports.
 */

export {
  fetchAllXceedEvents,
  fetchXceedBookingsFrom,
  fetchXceedBookingsPage,
  PAGE_LIMIT,
} from "./client.js";

export {
  readLastOffset,
  writeLastOffset,
  upsertEvent,
  upsertBooking,
  upsertOffer,
  enrichVenueCity,
} from "./sql.js";

export { syncXceedData } from "./sync.js";

export type {
  XceedVenue,
  XceedVenueDetail,
  XceedEvent,
  XceedPass,
  XceedOffer,
  XceedBuyer,
  XceedBooking,
  XceedSyncOptions,
  XceedSyncResult,
} from "./types.js";
