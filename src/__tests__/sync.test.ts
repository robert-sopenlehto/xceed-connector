/**
 * @file sync.test.ts
 * @description Unit tests for the syncXceedData orchestrator (sync.ts).
 * @rationale Mocks are used only for the two external boundaries: the HTTP API
 *   (via vi.stubGlobal fetch, tested indirectly through client functions) and
 *   the SQL database (via a mock ConnectionPool). Internal orchestration logic
 *   — offset management, offer accumulation, time-box exit, progress callbacks —
 *   is exercised directly against the real syncXceedData implementation.
 *
 * # @mock-exempt: fetch (external HTTP API) and sql.ConnectionPool (external DB)
 *   are the only boundaries mocked. All orchestration logic runs against the
 *   real syncXceedData function with no internal module mocking.
 *
 * Note on mock sequences: fetchAllXceedEvents stops pagination on a partial page
 * (< PAGE_LIMIT items), so a small events fixture does NOT trigger a second
 * empty-page fetch. Mock sequences must account for this — no "events stop" call
 * is needed when the events fixture has fewer than PAGE_LIMIT items.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncXceedData } from "../sync.js";
import type { XceedEvent, XceedBooking, XceedSyncOptions } from "../types.js";
import type { ConnectionPool } from "mssql";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEvent(uuid = "evt-1"): XceedEvent {
  return {
    id: 1,
    uuid,
    name: "Test Event",
    startingTime: 1700000000,
    endingTime: 1700010000,
    venue: { uuid: "venue-1", name: "Test Venue" },
    ticketsSold: 50,
  };
}

function makeBooking(id = "b-1", offerId = "offer-1", eventUuid = "evt-1"): XceedBooking {
  return {
    id,
    legacyId: 1001,
    buyer: { firstName: "Jane", lastName: "Doe", email: "jane@example.com", phone: null },
    quantity: 1,
    passes: [],
    event: {
      id: eventUuid,
      legacyId: 1,
      name: "Test Event",
      slug: "test-event",
      startingTime: 1700000000,
      endingTime: 1700010000,
      venue: { uuid: "venue-1", name: "Test Venue", city: "Lisboa" },
    },
    offer: {
      id: offerId,
      type: "ticket",
      name: "GA",
      description: "General Admission",
      price: { amount: "25.00", onlinePrice: 25, offlinePrice: 20, currency: "EUR" },
    },
    channel: "web",
    purchasedAt: 1699990000,
    confirmed: true,
  };
}

function makeApiResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve({ success: true, data }),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

// ── Mock SQL pool factory ─────────────────────────────────────────────────────
// Builds a minimal mock of mssql.ConnectionPool sufficient for the SQL helpers.
// The pool.request() chain is: pool.request().input(...).input(...).query(...)
// or pool.request().query(...)

function makeMockPool(syncStateOffset = 0): { pool: ConnectionPool; querySpy: ReturnType<typeof vi.fn> } {
  const querySpy = vi.fn().mockImplementation((sqlStr: string) => {
    // readLastOffset query — return the configured offset
    if (sqlStr.includes("sync_state") && sqlStr.includes("SELECT")) {
      return Promise.resolve({
        recordset: syncStateOffset > 0
          ? [{ value: String(syncStateOffset) }]
          : [],
      });
    }
    // All other queries (MERGE, UPDATE) succeed silently
    return Promise.resolve({ rowsAffected: [1] });
  });

  // Build a chainable request mock: each .input() returns the same object
  const requestChain = {
    input: vi.fn().mockReturnThis(),
    query: querySpy,
  };

  const pool = {
    request: vi.fn().mockReturnValue(requestChain),
  } as unknown as ConnectionPool;

  return { pool, querySpy };
}

function makeOptions(overrides: Partial<XceedSyncOptions> = {}): XceedSyncOptions {
  const { pool } = makeMockPool();
  return {
    apiKey: "test-api-key",
    pool,
    accountLabel: "TEST",
    timeBoxMs: 60_000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("syncXceedData", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads stored offset and resumes bookings sync from that position", async () => {
    const { pool, querySpy } = makeMockPool(200);

    // 1 event (< PAGE_LIMIT → pagination stops without extra call)
    // 1 booking at offset 200 (< PAGE_LIMIT → isLastPage=true)
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeApiResponse([makeEvent()]))   // events (partial page → stop)
      .mockResolvedValueOnce(makeApiResponse([makeBooking()])); // bookings at offset 200

    const result = await syncXceedData({ apiKey: "key", pool, accountLabel: "TEST" });

    // readLastOffset should have been called with the sync_state key
    const selectCall = querySpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("sync_state") && args[0].includes("SELECT")
    );
    expect(selectCall).toBeDefined();

    // bookings fetch should use offset=200 in the URL
    const fetchCalls = vi.mocked(fetch).mock.calls.map(([url]) => url as string);
    const bookingsFetch = fetchCalls.find((u) => u.includes("/bookings") && u.includes("offset=200"));
    expect(bookingsFetch).toBeDefined();

    expect(result.finalOffset).toBeGreaterThanOrEqual(200);
  });

  it("upserts each event returned by fetchAllXceedEvents", async () => {
    const { pool } = makeMockPool();

    // 2 events (< PAGE_LIMIT → stop), empty bookings
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeApiResponse([makeEvent("e1"), makeEvent("e2")]))
      .mockResolvedValueOnce(makeApiResponse([])); // bookings empty → stop

    await syncXceedData({ apiKey: "key", pool, accountLabel: "TEST" });

    // pool.request() is called for: readLastOffset, 2x upsertEvent, enrichVenueCity
    const requestCallCount = (pool.request as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(requestCallCount).toBeGreaterThanOrEqual(3); // at minimum: readOffset + 2 events
  });

  it("derives unique offers from bookings and upserts them", async () => {
    const { pool, querySpy } = makeMockPool();

    const bookings = [
      makeBooking("b-1", "offer-A", "evt-1"),
      makeBooking("b-2", "offer-A", "evt-1"), // same offer — should deduplicate
      makeBooking("b-3", "offer-B", "evt-1"), // different offer
    ];

    // 1 event (< PAGE_LIMIT → stop), 3 bookings (< PAGE_LIMIT → isLastPage=true)
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeApiResponse([makeEvent()]))
      .mockResolvedValueOnce(makeApiResponse(bookings));

    const result = await syncXceedData({ apiKey: "key", pool, accountLabel: "TEST" });

    expect(result.offersCount).toBe(2); // offer-A and offer-B, deduplicated
    expect(result.bookingsCount).toBe(3);

    // Verify upsertOffer SQL was called twice (for the 2 unique offers)
    const offerMerges = querySpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("raw_offers")
    );
    expect(offerMerges).toHaveLength(2);
  });

  it("persists offset after each page and returns correct finalOffset", async () => {
    const { pool, querySpy } = makeMockPool(0);

    // First page: 3 bookings (< PAGE_LIMIT → isLastPage)
    const bookings = [makeBooking("b-1"), makeBooking("b-2"), makeBooking("b-3")];

    vi.mocked(fetch)
      .mockResolvedValueOnce(makeApiResponse([makeEvent()]))
      .mockResolvedValueOnce(makeApiResponse(bookings));

    const result = await syncXceedData({ apiKey: "key", pool, accountLabel: "TEST" });

    expect(result.finalOffset).toBe(3);

    // writeLastOffset should have stored "3" in sync_state
    const writeCalls = querySpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("sync_state") && args[0].includes("MERGE")
    );
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("stops fetching when time-box is reached and sets timeBoxReached=true", async () => {
    const { pool } = makeMockPool(0);

    // Full page (PAGE_LIMIT=100 items) → isLastPage=false → loop would continue
    const PAGE_LIMIT_SIZE = 100;
    const firstPage = Array.from({ length: PAGE_LIMIT_SIZE }, (_, i) =>
      makeBooking(`b-${i}`)
    );

    // Control Date.now precisely:
    //   Call 1  → start = T         (sync.ts line: const start = Date.now())
    //   Call 2  → T (loop iter 1)   → T - T = 0 <= timeBoxMs → passes, page is fetched
    //   Call 3+ → T + timeBoxMs + 1 (loop iter 2 check fires → timeBoxReached=true)
    const T = 1_000_000;
    const TIME_BOX = 5_000;
    let nowCallCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowCallCount++;
      return nowCallCount <= 2 ? T : T + TIME_BOX + 1;
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(makeApiResponse([makeEvent()]))  // events (1 item, partial → stop)
      .mockResolvedValueOnce(makeApiResponse(firstPage));      // booking page 1 (full → isLastPage=false)

    const result = await syncXceedData({
      apiKey: "key",
      pool,
      accountLabel: "TEST",
      timeBoxMs: TIME_BOX,
    });

    expect(result.timeBoxReached).toBe(true);
    expect(result.bookingsCount).toBe(PAGE_LIMIT_SIZE);
  });

  it("returns correct counts in the result", async () => {
    const { pool } = makeMockPool(0);

    const events = [makeEvent("e1"), makeEvent("e2")];
    const bookings = [
      makeBooking("b-1", "offer-1", "e1"),
      makeBooking("b-2", "offer-2", "e2"),
    ];

    // 2 events (< PAGE_LIMIT → stop), 2 bookings (< PAGE_LIMIT → last)
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeApiResponse(events))
      .mockResolvedValueOnce(makeApiResponse(bookings));

    const result = await syncXceedData({ apiKey: "key", pool, accountLabel: "TEST" });

    expect(result.eventsCount).toBe(2);
    expect(result.bookingsCount).toBe(2);
    expect(result.offersCount).toBe(2);
    expect(result.timeBoxReached).toBe(false);
  });

  it("calls onProgress for each milestone", async () => {
    const { pool } = makeMockPool(0);
    const progressMessages: string[] = [];

    vi.mocked(fetch)
      .mockResolvedValueOnce(makeApiResponse([makeEvent()]))
      .mockResolvedValueOnce(makeApiResponse([makeBooking()]));

    await syncXceedData({
      apiKey: "key",
      pool,
      accountLabel: "MY_ACCOUNT",
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(progressMessages.length).toBeGreaterThanOrEqual(3);
    // Should include account label in messages
    expect(progressMessages.every((m) => m.includes("MY_ACCOUNT"))).toBe(true);
    // Should mention events and offers
    expect(progressMessages.some((m) => m.includes("events"))).toBe(true);
    expect(progressMessages.some((m) => m.includes("offers"))).toBe(true);
  });
});
