/* Canonical raw table schema for xceed-connector consumers.
 *
 * Purpose: Authoritative DDL for xceed.raw_events, xceed.raw_bookings,
 *   xceed.raw_offers, and xceed.sync_state. All consumers of
 *   @robert-sopenlehto/xceed-connector MUST provision these tables before
 *   calling syncXceedData() or any upsert helper.
 *
 * Rationale: Single canonical schema eliminates DDL divergence across
 *   ads-uploader, moyg-intelligence, and azure-functions-client.
 *   Source: extracted from ads-uploader/database-project/migrations/037_xceed_raw_tables.sql.
 *   Schema guard and _meta.migrations INSERT removed — consumers run this as
 *   a plain DDL script, not a tracked migration.
 *
 * @decision DEC-PKG-005
 * @title Canonical schema is ONE schema — hard cutover, no old/new coexistence
 * @status accepted
 * @rationale Each consumer migrates its tables to match this DDL in a single
 *   migration. Keeps the package simple (one set of table/column names) and
 *   avoids confusion about which schema is current.
 *
 * @decision DEC-XCEED-008
 * @title raw_json on all raw tables for schema evolution
 * @status accepted
 * @rationale Full API response stored as NVARCHAR(MAX) raw_json column so that
 *   new fields added by Xceed can be accessed without a DDL change.
 */

-- ── xceed.raw_events ─────────────────────────────────────────────────────────
-- One row per Xceed event UUID. Upserted on sync via MERGE on [uuid].

CREATE TABLE [xceed].[raw_events] (
    [uuid]           NVARCHAR(256)      NOT NULL,
    [name]           NVARCHAR(500)      NULL,
    [starting_time]  DATETIMEOFFSET     NULL,
    [ending_time]    DATETIMEOFFSET     NULL,
    [tickets_sold]   INT                NULL,
    [venue_name]     NVARCHAR(300)      NULL,
    [venue_uuid]     NVARCHAR(256)      NULL,
    [venue_city]     NVARCHAR(200)      NULL,
    [raw_json]       NVARCHAR(MAX)      NULL,
    [synced_at]      DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT [PK_xceed_raw_events] PRIMARY KEY ([uuid])
);
GO

-- ── xceed.raw_bookings ───────────────────────────────────────────────────────
-- One row per Xceed booking UUID. Upserted on sync via MERGE on [booking_id].
-- Incremental sync resumes from last_offset stored in xceed.sync_state
-- (DEC-XCEED-010 — offset-based, not watermark-based).

CREATE TABLE [xceed].[raw_bookings] (
    [id]               INT IDENTITY(1,1)  NOT NULL,
    [booking_id]       NVARCHAR(256)      NOT NULL,
    [event_uuid]       NVARCHAR(256)      NOT NULL,
    [quantity]         INT                NULL,
    [price]            DECIMAL(19,4)      NULL,
    [currency]         NVARCHAR(10)       NOT NULL DEFAULT 'EUR',
    [offer_id]         NVARCHAR(256)      NULL,
    [offer_name]       NVARCHAR(300)      NULL,
    [offer_type]       NVARCHAR(100)      NULL,
    [purchased_at]     DATETIMEOFFSET     NULL,
    [buyer_email]      NVARCHAR(300)      NULL,
    [buyer_first_name] NVARCHAR(200)      NULL,
    [buyer_last_name]  NVARCHAR(200)      NULL,
    [buyer_phone]      NVARCHAR(100)      NULL,
    [channel]          NVARCHAR(100)      NULL,
    [confirmed]        BIT                NULL,
    [pass_count]       INT                NULL,
    [raw_json]         NVARCHAR(MAX)      NULL,
    [synced_at]        DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT [PK_xceed_raw_bookings]        PRIMARY KEY ([id]),
    CONSTRAINT [UQ_xceed_raw_bookings_bid]    UNIQUE ([booking_id])
);
GO

CREATE INDEX [IX_xceed_raw_bookings_event]
    ON [xceed].[raw_bookings] ([event_uuid]);
GO

CREATE INDEX [IX_xceed_raw_bookings_purchased]
    ON [xceed].[raw_bookings] ([purchased_at]);
GO

CREATE INDEX [IX_xceed_raw_bookings_email]
    ON [xceed].[raw_bookings] ([buyer_email]);
GO

-- ── xceed.raw_offers ─────────────────────────────────────────────────────────
-- One row per offer+event combination. Composite PK prevents duplicates.
-- Populated from bookings payload — events endpoint has no offer detail
-- (DEC-XCEED-011).

CREATE TABLE [xceed].[raw_offers] (
    [offer_id]            NVARCHAR(256)  NOT NULL,
    [event_uuid]          NVARCHAR(256)  NOT NULL,
    [name]                NVARCHAR(300)  NULL,
    [price]               DECIMAL(19,4)  NULL,
    [available_tickets]   INT            NULL,
    [raw_json]            NVARCHAR(MAX)  NULL,
    [synced_at]           DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT [PK_xceed_raw_offers] PRIMARY KEY ([offer_id], [event_uuid])
);
GO

CREATE INDEX [IX_xceed_raw_offers_event]
    ON [xceed].[raw_offers] ([event_uuid]);
GO

-- ── xceed.sync_state ─────────────────────────────────────────────────────────
-- Key-value store for per-account sync cursors.
-- Key convention: "bookings_offset_{ACCOUNT_LABEL}"
-- e.g. "bookings_offset_BRUNCH_LISBOA", "bookings_offset_MOYG"
-- Value: string-encoded offset integer (DEC-XCEED-010, DEC-PKG-004).

CREATE TABLE [xceed].[sync_state] (
    [key]        NVARCHAR(100)  NOT NULL,
    [value]      NVARCHAR(MAX)  NULL,
    [updated_at] DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT [PK_xceed_sync_state] PRIMARY KEY ([key])
);
GO
