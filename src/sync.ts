/**
 * @file sync.ts
 * @description Xceed sync orchestrator. Calls client fetch helpers and SQL
 *   upsert helpers in sequence: read offset → fetch events → page-by-page
 *   bookings with offset persistence → derive offers → enrich venue_city.
 * @rationale Single entry-point function (syncXceedData) lets consumers replace
 *   all inline orchestration with one call while retaining control over timer
 *   registration, SQL pooling, and pipeline logging (DEC-PKG-002, DEC-PKG-006).
 *
 * @decision DEC-PKG-002
 * @title Package exports sync orchestrator, not just API client
 * @status accepted
 * @rationale The package exports syncXceedData() which handles the full
 *   fetch-and-upsert cycle. Consumers call one function instead of
 *   reimplementing orchestration. The orchestrator accepts callbacks for
 *   progress logging and a time-box parameter (Azure Functions 10-min limit
 *   varies by plan).
 *
 * @decision DEC-PKG-004
 * @title Multi-account via accountLabel parameter on syncXceedData
 * @status accepted
 * @rationale syncXceedData({ accountLabel: "MOYG" }) writes sync_state key
 *   bookings_offset_MOYG. A single database can host data from multiple Xceed
 *   accounts by calling syncXceedData() once per account. No hard-coded names.
 *
 * @decision DEC-PKG-006
 * @title Package does NOT own timer registration or pipeline logging
 * @status accepted
 * @rationale Timer registration (app.timer()) and pipeline logging
 *   (logPipelineRun()) are consumer-specific infrastructure. The package
 *   provides an onProgress callback for consumers to wire into their logging.
 *   This keeps the package dependency-free from Azure Functions SDK and
 *   consumer-specific logging schemas.
 *
 * @decision DEC-XCEED-010
 * @title Offset-based incremental sync (not watermark)
 * @status accepted
 * @rationale Xceed bookings API returns results OLDEST FIRST. Offset persisted
 *   after each page so a time-box exit does not restart progress from 0 on the
 *   next run. Overlap is safe because MERGE on booking_id handles duplicates.
 *
 * @decision DEC-XCEED-011
 * @title Offers derived from bookings payload, not events endpoint
 * @status accepted
 * @rationale Events endpoint has no offer detail. Unique (offer_id, event_uuid)
 *   pairs are accumulated across all booking pages then upserted in bulk.
 */

import { fetchAllXceedEvents, fetchXceedBookingsPage } from "./client.js";
import {
  readLastOffset,
  writeLastOffset,
  upsertEvent,
  upsertBooking,
  upsertOffer,
  enrichVenueCity,
} from "./sql.js";
import type { XceedSyncOptions, XceedSyncResult } from "./types.js";

/** Default time-box: 5 minutes — leaves a safety margin before the 10-min Azure hard limit. */
const DEFAULT_TIME_BOX_MS = 5 * 60 * 1000;

/**
 * Orchestrate a full Xceed sync cycle for a single account.
 *
 * Steps:
 * 1. Read last bookings offset from xceed.sync_state
 * 2. Fetch all events → upsert each via upsertEvent
 * 3. Page-by-page bookings loop with time-box check:
 *    - Fetch one page, upsert each booking
 *    - Accumulate unique (offer_id, event_uuid) pairs
 *    - Persist offset after each page
 *    - Stop if isLastPage or time-box reached
 * 4. Upsert all accumulated offers via upsertOffer
 * 5. Enrich venue_city on raw_events via CROSS APPLY (DEC-XCEED-012)
 *
 * @param options.apiKey       Xceed API key for this account
 * @param options.pool         mssql ConnectionPool (consumer-provided)
 * @param options.accountLabel Label used in sync_state key (e.g. "BRUNCH_LISBOA")
 * @param options.timeBoxMs    Max elapsed ms before stopping (default 5 min)
 * @param options.onProgress   Optional progress callback wired to consumer logging
 * @returns Counts of synced entities and final state
 */
export async function syncXceedData(
  options: XceedSyncOptions
): Promise<XceedSyncResult> {
  const {
    apiKey,
    pool,
    accountLabel,
    timeBoxMs = DEFAULT_TIME_BOX_MS,
    onProgress,
    transformBooking,
  } = options;

  const progress = (msg: string) => onProgress?.(msg);
  const start = Date.now();

  // ── Step 1: Read last offset ───────────────────────────────────────────────
  const lastOffset = await readLastOffset(pool, accountLabel);
  progress(`[xceed-connector] ${accountLabel}: starting sync from bookings offset ${lastOffset}`);

  // ── Step 2: Fetch and upsert events ───────────────────────────────────────
  const events = await fetchAllXceedEvents(apiKey);
  for (const event of events) {
    await upsertEvent(pool, event);
  }
  progress(`[xceed-connector] ${accountLabel}: upserted ${events.length} events`);

  // ── Step 3: Page-by-page bookings with time-box ────────────────────────────
  let currentOffset = lastOffset;
  let bookingsCount = 0;
  let timeBoxReached = false;

  // Accumulate unique (offer_id, event_uuid) pairs across all pages (DEC-XCEED-011)
  const offersSeen = new Map<
    string,
    {
      offerId: string;
      eventUuid: string;
      offerName: string;
      price: number | null;
      rawJson: string;
    }
  >();

  while (true) {
    // Time-box check — stop before the Azure Function hard limit
    if (Date.now() - start > timeBoxMs) {
      timeBoxReached = true;
      progress(
        `[xceed-connector] ${accountLabel}: time-box reached (${Math.round((Date.now() - start) / 1000)}s), ` +
          `stopping at offset ${currentOffset}`
      );
      break;
    }

    const { bookings: page, nextOffset, isLastPage } =
      await fetchXceedBookingsPage(apiKey, currentOffset);

    if (page.length === 0) break;

    // Upsert each booking in this page (apply transform if provided, e.g. PII stripping)
    for (const booking of page) {
      const b = transformBooking ? transformBooking(booking) : booking;
      await upsertBooking(pool, b);
    }
    bookingsCount += page.length;

    // Accumulate unique offers from this page
    for (const booking of page) {
      const key = `${booking.offer.id}|${booking.event.id}`;
      if (!offersSeen.has(key)) {
        const price = parseFloat(booking.offer.price.amount);
        offersSeen.set(key, {
          offerId: booking.offer.id,
          eventUuid: booking.event.id,
          offerName: booking.offer.name,
          price: isNaN(price) ? null : price,
          rawJson: JSON.stringify(booking.offer),
        });
      }
    }

    // Persist offset after each page — incremental progress survives time-box exit
    currentOffset = nextOffset;
    await writeLastOffset(pool, accountLabel, currentOffset);

    progress(
      `[xceed-connector] ${accountLabel}: page synced — ${page.length} bookings ` +
        `(total: ${bookingsCount}, offset: ${currentOffset})`
    );

    if (isLastPage) break;
  }

  // ── Step 4: Upsert accumulated offers ─────────────────────────────────────
  for (const offer of offersSeen.values()) {
    await upsertOffer(
      pool,
      offer.offerId,
      offer.eventUuid,
      offer.offerName,
      offer.price,
      offer.rawJson
    );
  }
  progress(
    `[xceed-connector] ${accountLabel}: upserted ${offersSeen.size} unique offers`
  );

  // ── Step 5: Enrich venue_city from bookings (DEC-XCEED-012) ───────────────
  await enrichVenueCity(pool);
  progress(`[xceed-connector] ${accountLabel}: venue_city enrichment complete`);

  return {
    eventsCount: events.length,
    bookingsCount,
    offersCount: offersSeen.size,
    finalOffset: currentOffset,
    timeBoxReached,
  };
}
