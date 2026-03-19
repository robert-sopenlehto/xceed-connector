# MASTER_PLAN.md -- xceed-connector

## Original Intent

Extract the Xceed API client, sync orchestrator, SQL upsert helpers, and canonical raw table schema from ads-uploader into a standalone npm package (`@robert-sopenlehto/xceed-connector`) published to GitHub Packages. The package eliminates copy-paste duplication across ads-uploader, moyg-intelligence, and azure-functions-client — three codebases that each maintain their own diverging version of the same Xceed integration code. Consumers inject their own API key and SQL connection pool; the package owns the protocol (fetch, retry, pagination, upsert, offset tracking) and the canonical table schema contract.

## Project Identity

`@robert-sopenlehto/xceed-connector` is a shared npm package (published to GitHub Packages) that encapsulates all Xceed API access: the REST client, TypeScript interfaces, sync orchestrator logic, and the canonical raw table SQL schema. It is consumed by three Azure Function App projects that each own their own timer registration, SQL connection pooling, transform SPs, and analytics layers.

**Problem statement**: The Xceed API client and raw-table sync logic is currently copy-pasted across three codebases:

| Codebase | Location | Account | Notes |
|----------|----------|---------|-------|
| ads-uploader/azure-functions | `src/lib/xceed-api.ts` + `src/functions/timerXceedSync.ts` | Brunch Lisboa | Stateless fetch helpers, incremental offset sync |
| ads-uploader/azure-functions-client | Same files (copy) | Brunch Lisboa (client tenant, DEC-TENANT-001) | Near-identical copy with manual HTTP trigger |
| moyg-intelligence | `src/lib/xceed-api.ts` + `src/functions/timerXceedSync.ts` | MOYG (Neopop + some Lisboa) | Class-based client, full-fetch strategy, different schema |

All three diverge in type definitions, retry logic, sync strategy, and raw table schemas. Bug fixes (e.g., venue_city enrichment) must be applied three times. The xceed-connector package eliminates this duplication.

## What Already Exists

The canonical implementation lives in ads-uploader/azure-functions (the most mature version):

- **xceed-api.ts**: Stateless fetch helpers with 429/5xx retry, exponential backoff, offset-based pagination. 348 lines.
- **timerXceedSync.ts**: Page-by-page incremental sync with offset persistence, time-box safety (8 min), offer derivation from bookings, venue_city enrichment. 426 lines.
- **037_xceed_raw_tables.sql**: Canonical raw table DDL (raw_events, raw_bookings, raw_offers, sync_state).
- **Decisions**: DEC-XCEED-001, 003, 005, 006, 007, 008, 010, 011, 012 (all accepted).
- **Tests**: moyg-intelligence has XceedClient unit tests (pagination, retry, error handling) -- these transfer to the package.

The MOYG version differs:
- Class-based XceedClient (vs stateless functions)
- Full-fetch strategy (no incremental offset)
- Different raw table names (xceed.events/orders vs xceed.raw_events/raw_bookings)
- 23% VAT (incorrect -- should be 6%, DEC-XCEED-006)
- No raw_offers table, no offer derivation

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  @robert-sopenlehto/xceed-connector      │
│                   (GitHub Packages, npm)                 │
│                                                          │
│  src/                                                    │
│  ├── client.ts          XceedClient class (fetch helpers)│
│  ├── types.ts           All Xceed API type interfaces    │
│  ├── sync.ts            syncXceedData() orchestrator     │
│  └── index.ts           Public API barrel export         │
│                                                          │
│  sql/                                                    │
│  └── canonical-schema.sql  raw_events, raw_bookings,     │
│                            raw_offers, sync_state DDL    │
│                                                          │
│  Exports:                                                │
│  - fetchAllXceedEvents   (API fetch + pagination)        │
│  - fetchXceedBookingsPage/From                           │
│  - syncXceedData(opts)   (orchestrator: fetch → upsert)  │
│  - Types: XceedEvent, XceedBooking, XceedOffer, etc.     │
│  - SQL helpers: upsert functions for each raw table      │
│  - Constants: PAGE_LIMIT                                 │
└──────────────────────┬──────────────────────────────────┘
                       │ npm install
          ┌────────────┼────────────────┐
          ▼            ▼                ▼
┌─────────────┐ ┌──────────────┐ ┌──────────────────┐
│ ads-uploader│ │ MOYG         │ │ azure-functions   │
│ azure-      │ │ intelligence │ │ -client           │
│ functions   │ │              │ │ (Centris tenant)  │
│             │ │              │ │                   │
│ Timer reg   │ │ Timer reg    │ │ Timer reg         │
│ SQL pool    │ │ SQL pool     │ │ SQL pool          │
│ Transform   │ │ Transform    │ │ Transform         │
│ SPs         │ │ SPs          │ │ SPs + HTTP trigger│
│             │ │              │ │                   │
│ XCEED_API_  │ │ XCEED_API_   │ │ XCEED_API_KEY_    │
│ KEY_BRUNCH_ │ │ KEY (MOYG    │ │ BRUNCH_LISBOA     │
│ LISBOA      │ │ account)     │ │                   │
└─────────────┘ └──────────────┘ └──────────────────┘

Multi-account: Each consumer passes its own API key.
The package is key-agnostic — it takes apiKey as a parameter.
MOYG and Brunch Lisboa data can land in the same raw tables
(sync_state keys differentiate accounts: "bookings_offset_MOYG",
"bookings_offset_BRUNCH_LISBOA").
```

### Package Boundary

The xceed-connector package owns:
- **Xceed API communication** (HTTP fetch, pagination, retry, rate limiting)
- **TypeScript type definitions** for all Xceed API response shapes
- **Sync orchestration logic** (fetch events, fetch bookings page-by-page, derive offers, enrich venue_city)
- **SQL upsert helpers** (parameterized MERGE statements for each raw table)
- **Canonical raw table DDL** (the contract consumers must implement)

The package does NOT own:
- Timer registration (Azure Functions `app.timer()` -- consumer responsibility)
- SQL connection pooling (`getPool()` -- consumer injects `sql.ConnectionPool`)
- Transform stored procedures (consumer's analytical layer)
- Pipeline logging (`logPipelineRun()` -- consumer's observability)
- Environment variable resolution (consumer passes apiKey, pool)

## Canonical Raw Table Schema (The Contract)

All consumers MUST have these tables in an `xceed` schema. This is the authoritative DDL.

### xceed.raw_events

```sql
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
```

### xceed.raw_bookings

```sql
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
    CONSTRAINT [PK_xceed_raw_bookings]     PRIMARY KEY ([id]),
    CONSTRAINT [UQ_xceed_raw_bookings_bid] UNIQUE ([booking_id])
);
-- Indexes
CREATE INDEX [IX_xceed_raw_bookings_event]     ON [xceed].[raw_bookings] ([event_uuid]);
CREATE INDEX [IX_xceed_raw_bookings_purchased] ON [xceed].[raw_bookings] ([purchased_at]);
CREATE INDEX [IX_xceed_raw_bookings_email]     ON [xceed].[raw_bookings] ([buyer_email]);
```

### xceed.raw_offers

```sql
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
CREATE INDEX [IX_xceed_raw_offers_event] ON [xceed].[raw_offers] ([event_uuid]);
```

### xceed.sync_state

```sql
CREATE TABLE [xceed].[sync_state] (
    [key]        NVARCHAR(100)  NOT NULL,
    [value]      NVARCHAR(MAX)  NULL,
    [updated_at] DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT [PK_xceed_sync_state] PRIMARY KEY ([key])
);
```

### Schema notes

- **buyer_first_name / buyer_last_name**: Kept as separate columns (not concatenated). The canonical schema has always had separate columns. No downstream consumers require a combined field.
- **raw_json**: Full API response on every table for schema evolution (DEC-XCEED-008). New Xceed fields are accessible without DDL changes.
- **sync_state keys**: Multi-account convention is `bookings_offset_{ACCOUNT_LABEL}` (e.g., `bookings_offset_BRUNCH_LISBOA`, `bookings_offset_MOYG`).

## NOT in Scope

- **Transform stored procedures** (ExCentris.xceed_transform_*, MadeOfYou.sp_transform_*) -- consumer-specific analytical models
- **Timer registration** (Azure Functions `app.timer()`) -- consumer-specific schedule, stagger, time-box config
- **SQL connection pooling** -- consumer-specific infrastructure (mssql, Supabase, etc.)
- **Pipeline logging** (`logPipelineRun()`, `_meta.pipeline_log`) -- consumer-specific observability
- **Analytics / dimensional model** -- PI platform scope
- **VAT calculations** -- consumer transform layer (6% for Xceed Portugal events, DEC-XCEED-006)
- **Brand parsing** (Neopop / Brunch Lisboa detection) -- consumer transform layer
- **Cross-client buyer identity resolution** -- PI platform scope
- **Xceed API authentication** (obtaining API keys) -- operational, not code

## Phases

### Phase 1: Scaffold and Extract (1-2 days)

**Goal**: Create the xceed-connector repo, extract code from ads-uploader, establish the package structure.

**Status**: Complete (this commit).

**Deliverables**:
1. Initialize `xceed-connector` private GitHub repo with TypeScript + npm package config
2. Extract API client functions from ads-uploader xceed-api.ts into `client.ts`
   - Stateless `apiKey` parameter pattern (DEC-XCEED-001) -- no process.env reads
   - Full retry logic: exponential backoff for 429 + 5xx, Retry-After header support, 10 retries
   - Expose: `fetchAllXceedEvents()`, `fetchXceedBookingsFrom()`, `fetchXceedBookingsPage()`
3. Extract TypeScript interfaces into `types.ts`
   - Canonical types from ads-uploader (most complete)
4. Extract sync orchestrator into `sync.ts`
   - `syncXceedData(options)`: fetch events, page-by-page bookings, derive offers, enrich venue_city
   - Accepts: `{ apiKey, pool, accountLabel, timeBoxMs?, onProgress? }`
   - Handles: offset read/write, upsert calls, offer derivation (DEC-XCEED-011), venue_city enrichment (DEC-XCEED-012)
5. SQL upsert helpers in `sql.ts`
   - `upsertEvent()`, `upsertBooking()`, `upsertOffer()`, `enrichVenueCity()`, `readLastOffset()`, `writeLastOffset()`
   - All accept `sql.ConnectionPool` as first parameter
6. Canonical schema DDL in `sql/canonical-schema.sql`
7. Unit tests (port from MOYG + expand)
   - Client: pagination, retry, error handling
   - Sync: offset management, offer derivation, time-box exit

### Phase 2: Publish and Migrate ads-uploader (2-3 days)

**Goal**: Publish v1.0.0 to GitHub Packages, replace inline code in ads-uploader/azure-functions with the package.

**Deliverables**:
1. Configure GitHub Actions for publishing to `@robert-sopenlehto` scope on GitHub Packages
2. Publish `@robert-sopenlehto/xceed-connector@1.0.0`
3. In ads-uploader/azure-functions:
   - `npm install @robert-sopenlehto/xceed-connector`
   - Replace `src/lib/xceed-api.ts` with re-export from package (or delete + update imports)
   - Rewrite `timerXceedSync.ts` to call `syncXceedData()` from the package
   - Keep timer registration (`app.timer()`) and pipeline logging local
   - Keep transform SP call (`ExCentris.xceed_refresh_all`) local
4. Verify ads-uploader sync still works end-to-end (existing tests + manual trigger)
5. Remove dead inline code from ads-uploader/azure-functions

**Migration pattern** (ads-uploader/azure-functions/src/functions/timerXceedSync.ts):
```typescript
import { syncXceedData } from "@robert-sopenlehto/xceed-connector";
import { getPool } from "../lib/sql-pool.js";
import { logPipelineRun } from "../lib/pipeline-utils.js";

async function handler(_timer, context) {
  const apiKey = process.env.XCEED_API_KEY_BRUNCH_LISBOA;
  const pool = await getPool();
  const result = await syncXceedData({
    apiKey,
    pool,
    accountLabel: "BRUNCH_LISBOA",
    timeBoxMs: 8 * 60 * 1000,
    onProgress: (msg) => context.log(msg),
  });
  await pool.request().execute("ExCentris.xceed_refresh_all");
  await logPipelineRun(pool, "timerXceedSync", "INFO", ...);
}
```

### Phase 3: Migrate MOYG Intelligence (3-5 days)

**Goal**: Migrate MOYG to consume the package. This is the largest phase because MOYG's raw tables must change to match the canonical schema.

**Deliverables**:

**3A. Canonical schema migration**
- MOYG currently has `xceed.events` (PK: xceed_uuid) and `xceed.orders` (PK: xceed_booking_id) with different column names/types
- Write migration to:
  1. Rename `xceed.events` to `xceed.raw_events` with canonical column names
  2. Rename `xceed.orders` to `xceed.raw_bookings` with canonical column names
  3. Create `xceed.raw_offers` (new table -- MOYG never had this)
  4. Create `xceed.sync_state` (new table -- MOYG used full-fetch, no offset tracking)
- Data-preserving migration: ALTER + sp_rename, not DROP/CREATE

**3B. VAT correction**
- MOYG transform SPs currently use 23% VAT (DEC-MOYG-TAX-001) -- **incorrect**
- Correct to 6% (DEC-XCEED-006: Portuguese IVA for cultural events)

**3C. Multi-account support**
- MOYG has its own Xceed API key (separate account: 8 events, Neopop + some Lisboa)
- Both accounts' data lands in the same raw tables on the MOYG database
- sync_state keys: `bookings_offset_MOYG`, `bookings_offset_BRUNCH_LISBOA`

**3D. Switch to incremental sync**
- Replace full-fetch strategy with package's offset-based incremental sync (DEC-XCEED-010)

**3E. Consume the package**
- `npm install @robert-sopenlehto/xceed-connector`
- Delete `src/lib/xceed-api.ts` (replaced by package)
- Rewrite `src/functions/timerXceedSync.ts` to use `syncXceedData()`

**3F. Update transform SPs**
- Update column references in `xceed.sp_transform_*` SPs to match canonical column names

### Phase 4: Migrate azure-functions-client (1-2 days)

**Goal**: Replace the copy-pasted code in ads-uploader/azure-functions-client with the package.

**Deliverables**:
1. `npm install @robert-sopenlehto/xceed-connector` in azure-functions-client
2. Rewrite `timerXceedSync.ts` to use `syncXceedData()` (same pattern as Phase 2)
3. Keep the manual HTTP trigger (`manualXceedSync` POST endpoint) -- just wire it to the package
4. Keep timer registration and `ExCentris.xceed_refresh_all` SP call local
5. Delete `src/lib/xceed-api.ts` and inline sync code

## Decision Registry

### Carried forward from ads-uploader (package inherits these)

| ID | Title | Status |
|----|-------|--------|
| DEC-XCEED-001 | Xceed API REST client -- stateless fetch helpers, apiKey as parameter | Accepted |
| DEC-XCEED-003 | Separate timerXceedSync per consumer -- avoids shared transaction risk | Accepted |
| DEC-XCEED-005 | Buyer identity via email hash, anonymous fallback UUID | Accepted |
| DEC-XCEED-006 | Portuguese IVA 6% for cultural events (not 23%) | Accepted |
| DEC-XCEED-007 | Composite product UUID: XCEED-PRD-{offer_id}-{event_uuid} | Accepted |
| DEC-XCEED-008 | raw_json on all raw tables for schema evolution | Accepted |
| DEC-XCEED-009 | API tickets_sold is authoritative for edition_sold | Accepted |
| DEC-XCEED-010 | Offset-based incremental sync (not watermark) | Accepted |
| DEC-XCEED-011 | Offers derived from bookings payload, not events endpoint | Accepted |
| DEC-XCEED-012 | Venue city sourced from bookings endpoint (events lacks city) | Accepted |

### New decisions for this project

| ID | Title | Status |
|----|-------|--------|
| DEC-PKG-001 | Publish to GitHub Packages (not npm public, not local file ref) | Accepted |
| DEC-PKG-002 | Package exports sync orchestrator, not just API client | Accepted |
| DEC-PKG-003 | SQL upsert helpers accept mssql ConnectionPool (not abstracted) | Accepted |
| DEC-PKG-004 | Multi-account via accountLabel parameter on syncXceedData | Accepted |
| DEC-PKG-005 | Canonical schema is ONE schema -- hard cutover, no old/new coexistence | Accepted |
| DEC-PKG-006 | Package does NOT own timer registration or pipeline logging | Accepted |

### DEC-PKG-001 -- GitHub Packages
Published to `@robert-sopenlehto` scope on GitHub Packages. Private registry (not public npm). All three consumer repos already authenticate with GitHub for CI -- no new credential management needed.

### DEC-PKG-002 -- Sync orchestrator in package
The package exports `syncXceedData()` which handles the full fetch-and-upsert cycle: events, page-by-page bookings with offset persistence, offer derivation, venue_city enrichment. Consumers call one function instead of reimplementing the orchestration. The orchestrator accepts callbacks for progress logging (consumer-specific) and a time-box parameter (Azure Functions 10-min limit varies by plan).

### DEC-PKG-003 -- mssql ConnectionPool dependency
SQL upsert helpers take `sql.ConnectionPool` directly. All three consumers use `mssql` against Azure SQL. Abstracting to a generic interface adds complexity without value -- if a future consumer uses a different SQL client, a thin adapter is straightforward.

### DEC-PKG-004 -- Multi-account via accountLabel
`syncXceedData({ accountLabel: "MOYG" })` writes sync_state key `bookings_offset_MOYG`. A single database can host data from multiple Xceed accounts by calling `syncXceedData()` once per account. The package does not hard-code account names.

### DEC-PKG-005 -- Hard cutover to canonical schema
No coexistence period with old table names. Each consumer migrates its tables to match the canonical DDL (raw_events, raw_bookings, raw_offers, sync_state) in a single migration. This keeps the package simple (one set of table/column names) and avoids confusion about which schema is "current".

### DEC-PKG-006 -- Package boundary excludes timer and logging
Timer registration (`app.timer()`) and pipeline logging (`logPipelineRun()`) are consumer-specific infrastructure. The package provides an `onProgress` callback for consumers to wire into their logging. This keeps the package dependency-free from Azure Functions SDK and consumer-specific logging schemas.

## Failure Modes

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| Package publish fails in CI | Consumers cannot update | Pin known-good version in package.json; manual publish fallback |
| Breaking change in package API | All three consumers break on update | Semver: breaking changes = major version bump; consumers pin minor |
| MOYG schema migration data loss | Historical data gone | Data-preserving migration (ALTER/RENAME); backup before running |
| Multi-account offset collision | Wrong bookings fetched | sync_state key includes accountLabel; no shared keys possible |
| MOYG 23% VAT data already in silver layer | Incorrect historical analytics | Re-run transform SP after VAT fix; recalculates all rows from raw |
| Rate limit from two accounts syncing simultaneously | 429 storm | Stagger timer schedules; package retry logic handles 429 gracefully |

## Test Coverage Map

| Component | Test Type | What's Covered |
|-----------|-----------|---------------|
| fetchAllXceedEvents | Unit (mock fetch) | Pagination, empty response, Unix timestamp preservation |
| fetchXceedBookingsFrom | Unit (mock fetch) | Multi-page pagination, offset calculation, partial page stop |
| fetchXceedBookingsPage | Unit (mock fetch) | Single page, isLastPage flag |
| fetchWithRetry | Unit (mock fetch) | 429 retry with Retry-After, 429 retry with backoff, 5xx retry, max retries exceeded |
| syncXceedData | Unit (mock fetch + pool) | Offset read/resume, page-by-page flow, offer derivation, venue_city enrichment, time-box exit |
| SQL upsert helpers | Unit (mock pool.request) | Correct parameter binding, MERGE SQL structure |
| Integration (ads-uploader) | Manual | End-to-end sync against live Xceed API after package migration |
| Integration (MOYG) | Manual | Schema migration + sync against live API |

## Timeline Estimate

| Phase | Duration | Depends on |
|-------|----------|-----------|
| Phase 1: Scaffold and Extract | 1-2 days | -- |
| Phase 2: Publish + ads-uploader migration | 2-3 days | Phase 1 |
| Phase 3: MOYG migration | 3-5 days | Phase 2 (published package) |
| Phase 4: azure-functions-client migration | 1-2 days | Phase 2 |
| **Total** | **7-12 days** | Phases 3 and 4 can parallelize |
