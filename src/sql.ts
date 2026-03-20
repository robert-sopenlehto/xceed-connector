/**
 * @file sql.ts
 * @description SQL upsert helpers for xceed.raw_* tables. All functions accept
 *   a mssql ConnectionPool as their first parameter so consumers inject their
 *   own connection infrastructure.
 * @rationale Extracted from ads-uploader timerXceedSync.ts. Keeping SQL helpers
 *   in a separate module lets consumers call individual upsert functions without
 *   invoking the full sync orchestrator (e.g. for backfill scripts or tests).
 *
 * @decision DEC-PKG-003
 * @title SQL upsert helpers accept mssql ConnectionPool (not abstracted)
 * @status accepted
 * @rationale All three consumers use mssql against Azure SQL. Abstracting to a
 *   generic interface adds complexity without value. If a future consumer uses a
 *   different SQL client, a thin adapter is straightforward.
 *
 * @decision DEC-XCEED-008
 * @title raw_json on all raw tables for schema evolution
 * @status accepted
 * @rationale Full API response stored as NVARCHAR(MAX) raw_json column so that
 *   new fields added by Xceed can be accessed without a schema migration.
 *
 * @decision DEC-XCEED-011
 * @title Offers derived from bookings payload, not events endpoint
 * @status accepted
 * @rationale The Xceed events endpoint does not return individual offer/tier
 *   detail. raw_offers is populated from the booking payload's embedded offer
 *   metadata — the only reliable source for offer names, prices, and tiers.
 *
 * @decision DEC-XCEED-012
 * @title Venue city sourced from bookings endpoint (events endpoint lacks city)
 * @status accepted
 * @rationale The events endpoint returns venue as {uuid, name} only — no city
 *   field. enrichVenueCity uses a CROSS APPLY to backfill raw_events.venue_city
 *   from the richer venue detail embedded in each booking's event.venue object.
 *   CROSS APPLY is a single SQL statement vs. the in-memory Map + per-row UPDATE
 *   approach used in ads-uploader — more efficient and avoids loading all bookings
 *   into memory in the package layer.
 */

import sql from "mssql";
import type { XceedEvent, XceedBooking } from "./types.js";

// ── Offset management ─────────────────────────────────────────────────────────

/**
 * Read the stored bookings offset from xceed.sync_state for the given account.
 * Returns 0 (full backfill) if no row exists yet.
 *
 * @param pool         mssql ConnectionPool
 * @param accountLabel Account label used as part of the sync_state key
 *                     (e.g. "BRUNCH_LISBOA" → key "bookings_offset_BRUNCH_LISBOA")
 */
export async function readLastOffset(
  pool: sql.ConnectionPool,
  accountLabel: string
): Promise<number> {
  const key = `bookings_offset_${accountLabel}`;
  const result = await pool
    .request()
    .input("key", sql.NVarChar(100), key)
    .query<{ value: string }>(
      `SELECT [value] FROM [xceed].[sync_state] WHERE [key] = @key`
    );
  if (result.recordset.length === 0) return 0;
  const parsed = parseInt(result.recordset[0].value, 10);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Persist the new bookings offset to xceed.sync_state for the given account.
 *
 * @param pool         mssql ConnectionPool
 * @param accountLabel Account label (e.g. "BRUNCH_LISBOA")
 * @param offset       New offset value to store
 */
export async function writeLastOffset(
  pool: sql.ConnectionPool,
  accountLabel: string,
  offset: number
): Promise<void> {
  const key = `bookings_offset_${accountLabel}`;
  await pool
    .request()
    .input("key", sql.NVarChar(100), key)
    .input("value", sql.NVarChar(sql.MAX), String(offset))
    .query(`
      MERGE [xceed].[sync_state] AS tgt
      USING (VALUES (@key, @value)) AS src ([key], [value])
      ON tgt.[key] = src.[key]
      WHEN MATCHED THEN UPDATE SET
          tgt.[value]      = src.[value],
          tgt.[updated_at] = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN INSERT ([key], [value])
      VALUES (src.[key], src.[value]);
    `);
}

// ── Event upsert ──────────────────────────────────────────────────────────────

/**
 * MERGE a single Xceed event into xceed.raw_events.
 * Timestamps are stored as DATETIMEOFFSET — epoch seconds converted via DATEADD.
 *
 * @param pool  mssql ConnectionPool
 * @param event Xceed event object
 */
export async function upsertEvent(
  pool: sql.ConnectionPool,
  event: XceedEvent
): Promise<void> {
  await pool
    .request()
    .input("uuid", sql.NVarChar(256), event.uuid)
    .input("name", sql.NVarChar(500), event.name)
    .input("startingTime", sql.Int, event.startingTime)
    .input("endingTime", sql.Int, event.endingTime)
    .input("ticketsSold", sql.Int, event.ticketsSold)
    .input("venueName", sql.NVarChar(300), event.venue.name)
    .input("venueUuid", sql.NVarChar(256), event.venue.uuid)
    .input("rawJson", sql.NVarChar(sql.MAX), JSON.stringify(event))
    .query(`
      MERGE [xceed].[raw_events] AS tgt
      USING (VALUES (
          @uuid, @name,
          DATEADD(SECOND, @startingTime, '1970-01-01'),
          DATEADD(SECOND, @endingTime, '1970-01-01'),
          @ticketsSold, @venueName, @venueUuid, @rawJson
      )) AS src (uuid, name, starting_time, ending_time, tickets_sold, venue_name, venue_uuid, raw_json)
      ON tgt.[uuid] = src.[uuid]
      WHEN MATCHED THEN UPDATE SET
          tgt.[name]          = src.[name],
          tgt.[starting_time] = src.[starting_time],
          tgt.[ending_time]   = src.[ending_time],
          tgt.[tickets_sold]  = src.[tickets_sold],
          tgt.[venue_name]    = src.[venue_name],
          tgt.[venue_uuid]    = src.[venue_uuid],
          tgt.[raw_json]      = src.[raw_json],
          tgt.[synced_at]     = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN INSERT
          ([uuid], [name], [starting_time], [ending_time], [tickets_sold], [venue_name], [venue_uuid], [raw_json])
      VALUES
          (src.[uuid], src.[name], src.[starting_time], src.[ending_time],
           src.[tickets_sold], src.[venue_name], src.[venue_uuid], src.[raw_json]);
    `);
}

// ── Booking upsert ────────────────────────────────────────────────────────────

/**
 * MERGE a single Xceed booking into xceed.raw_bookings.
 * purchasedAt is unix seconds — converted via DATEADD in SQL.
 * price.amount is a string ("18.00") — parseFloat before passing to SQL.
 * buyer name is stored in separate first/last columns (not concatenated).
 *
 * @param pool    mssql ConnectionPool
 * @param booking Xceed booking object
 */
export async function upsertBooking(
  pool: sql.ConnectionPool,
  booking: XceedBooking
): Promise<void> {
  const price = parseFloat(booking.offer.price.amount);
  const channelValue =
    typeof booking.channel === "string"
      ? booking.channel
      : (booking.channel as { name?: string } | null)?.name ?? null;

  await pool
    .request()
    .input("bookingId", sql.NVarChar(256), booking.id)
    .input("eventUuid", sql.NVarChar(256), booking.event.id)
    .input("quantity", sql.Int, booking.quantity)
    .input("price", sql.Decimal(19, 4), isNaN(price) ? null : price)
    .input("currency", sql.NVarChar(10), booking.offer.price.currency ?? "EUR")
    .input("offerId", sql.NVarChar(256), booking.offer.id)
    .input("offerName", sql.NVarChar(300), booking.offer.name)
    .input("offerType", sql.NVarChar(100), booking.offer.type)
    .input("purchasedAt", sql.Int, booking.purchasedAt)
    .input("buyerEmail", sql.NVarChar(300), booking.buyer.email ?? null)
    .input("buyerFirstName", sql.NVarChar(200), booking.buyer.firstName ?? null)
    .input("buyerLastName", sql.NVarChar(200), booking.buyer.lastName ?? null)
    .input("buyerPhone", sql.NVarChar(100), booking.buyer.phone ?? null)
    .input("channel", sql.NVarChar(100), channelValue)
    .input("confirmed", sql.Bit, booking.confirmed ? 1 : 0)
    .input("passCount", sql.Int, Array.isArray(booking.passes) ? booking.passes.length : 0)
    .input("rawJson", sql.NVarChar(sql.MAX), JSON.stringify(booking))
    .query(`
      MERGE [xceed].[raw_bookings] AS tgt
      USING (VALUES (
          @bookingId, @eventUuid, @quantity, @price, @currency,
          @offerId, @offerName, @offerType,
          DATEADD(SECOND, @purchasedAt, '1970-01-01'),
          @buyerEmail, @buyerFirstName, @buyerLastName, @buyerPhone,
          @channel, @confirmed, @passCount, @rawJson
      )) AS src (
          booking_id, event_uuid, quantity, price, currency,
          offer_id, offer_name, offer_type, purchased_at,
          buyer_email, buyer_first_name, buyer_last_name, buyer_phone,
          channel, confirmed, pass_count, raw_json
      )
      ON tgt.[booking_id] = src.[booking_id]
      WHEN MATCHED THEN UPDATE SET
          tgt.[event_uuid]       = src.[event_uuid],
          tgt.[quantity]         = src.[quantity],
          tgt.[price]            = src.[price],
          tgt.[currency]         = src.[currency],
          tgt.[offer_id]         = src.[offer_id],
          tgt.[offer_name]       = src.[offer_name],
          tgt.[offer_type]       = src.[offer_type],
          tgt.[purchased_at]     = src.[purchased_at],
          tgt.[buyer_email]      = src.[buyer_email],
          tgt.[buyer_first_name] = src.[buyer_first_name],
          tgt.[buyer_last_name]  = src.[buyer_last_name],
          tgt.[buyer_phone]      = src.[buyer_phone],
          tgt.[channel]          = src.[channel],
          tgt.[confirmed]        = src.[confirmed],
          tgt.[pass_count]       = src.[pass_count],
          tgt.[raw_json]         = src.[raw_json],
          tgt.[synced_at]        = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN INSERT (
          [booking_id], [event_uuid], [quantity], [price], [currency],
          [offer_id], [offer_name], [offer_type], [purchased_at],
          [buyer_email], [buyer_first_name], [buyer_last_name], [buyer_phone],
          [channel], [confirmed], [pass_count], [raw_json]
      ) VALUES (
          src.[booking_id], src.[event_uuid], src.[quantity], src.[price], src.[currency],
          src.[offer_id], src.[offer_name], src.[offer_type], src.[purchased_at],
          src.[buyer_email], src.[buyer_first_name], src.[buyer_last_name], src.[buyer_phone],
          src.[channel], src.[confirmed], src.[pass_count], src.[raw_json]
      );
    `);
}

// ── Offer upsert ──────────────────────────────────────────────────────────────

/**
 * MERGE a unique (offer_id, event_uuid) pair into xceed.raw_offers.
 * Derived from bookings payload — the events endpoint has no offer detail
 * (DEC-XCEED-011).
 *
 * @param pool      mssql ConnectionPool
 * @param offerId   Xceed offer UUID
 * @param eventUuid Xceed event UUID
 * @param offerName Human-readable offer name
 * @param price     Parsed price (null if unparseable)
 * @param rawJson   Serialised offer object for schema-evolution safety
 */
export async function upsertOffer(
  pool: sql.ConnectionPool,
  offerId: string,
  eventUuid: string,
  offerName: string,
  price: number | null,
  rawJson: string
): Promise<void> {
  await pool
    .request()
    .input("offerId", sql.NVarChar(256), offerId)
    .input("eventUuid", sql.NVarChar(256), eventUuid)
    .input("offerName", sql.NVarChar(300), offerName)
    .input("price", sql.Decimal(19, 4), price)
    .input("rawJson", sql.NVarChar(sql.MAX), rawJson)
    .query(`
      MERGE [xceed].[raw_offers] AS tgt
      USING (VALUES (@offerId, @eventUuid, @offerName, @price, @rawJson))
        AS src (offer_id, event_uuid, name, price, raw_json)
      ON tgt.[offer_id] = src.[offer_id] AND tgt.[event_uuid] = src.[event_uuid]
      WHEN MATCHED THEN UPDATE SET
          tgt.[name]      = src.[name],
          tgt.[price]     = src.[price],
          tgt.[raw_json]  = src.[raw_json],
          tgt.[synced_at] = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN INSERT ([offer_id], [event_uuid], [name], [price], [raw_json])
      VALUES (src.[offer_id], src.[event_uuid], src.[name], src.[price], src.[raw_json]);
    `);
}

// ── Venue city enrichment ─────────────────────────────────────────────────────

/**
 * Enrich xceed.raw_events.venue_city from the richer venue detail embedded in
 * booking payloads via a single SQL CROSS APPLY statement.
 *
 * The events endpoint returns venue as {uuid, name} only — city is available
 * only via the bookings response (DEC-XCEED-012). Only updates rows where
 * venue_city IS NULL or differs from the booking-derived value.
 *
 * Uses CROSS APPLY + JSON_VALUE rather than the in-memory Map + per-row UPDATE
 * approach: a single SQL statement avoids loading all booking JSON into the
 * package layer and is more efficient at scale.
 *
 * @param pool  mssql ConnectionPool
 */
export async function enrichVenueCity(
  pool: sql.ConnectionPool
): Promise<void> {
  await pool.request().query(`
    UPDATE e
    SET e.venue_city = b.city_name, e.synced_at = SYSDATETIMEOFFSET()
    FROM xceed.raw_events e
    CROSS APPLY (
        SELECT TOP 1 JSON_VALUE(rb.raw_json, '$.event.venue.city.name') AS city_name
        FROM xceed.raw_bookings rb
        WHERE rb.event_uuid = e.uuid
        AND JSON_VALUE(rb.raw_json, '$.event.venue.city.name') IS NOT NULL
    ) b
    WHERE e.venue_city IS NULL OR e.venue_city != b.city_name;
  `);
}
