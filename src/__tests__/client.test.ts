// @mock-exempt: global.fetch is the external HTTP boundary (Xceed REST API). No internal modules are mocked.
/**
 * @file client.test.ts
 * @description Unit tests for the Xceed API client (client.ts).
 * @rationale Tests use vi.stubGlobal to mock global fetch — the only external
 *   boundary here is the HTTP API. No internal modules are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchAllXceedEvents,
  fetchXceedBookingsPage,
  fetchXceedBookingsFrom,
  PAGE_LIMIT,
} from "../client.js";
import type { XceedEvent, XceedBooking } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<XceedEvent> = {}): XceedEvent {
  return {
    id: 1,
    uuid: "evt-uuid-1",
    name: "Test Event",
    startingTime: 1700000000,
    endingTime: 1700010000,
    venue: { uuid: "venue-1", name: "Test Venue" },
    ticketsSold: 100,
    ...overrides,
  };
}

function makeBooking(overrides: Partial<XceedBooking> = {}): XceedBooking {
  return {
    id: "booking-uuid-1",
    legacyId: 1001,
    buyer: {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: null,
    },
    quantity: 2,
    passes: [],
    event: {
      id: "evt-uuid-1",
      legacyId: 1,
      name: "Test Event",
      slug: "test-event",
      startingTime: 1700000000,
      endingTime: 1700010000,
      venue: { uuid: "venue-1", name: "Test Venue", city: "Lisboa" },
    },
    offer: {
      id: "offer-1",
      type: "ticket",
      name: "General Admission",
      description: "GA ticket",
      price: { amount: "25.00", onlinePrice: 25, offlinePrice: 20, currency: "EUR" },
    },
    channel: "web",
    purchasedAt: 1699990000,
    confirmed: true,
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers[key] ?? null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PAGE_LIMIT", () => {
  it("is exported and equals 100", () => {
    expect(PAGE_LIMIT).toBe(100);
  });
});

describe("fetchAllXceedEvents", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed events from a single page response", async () => {
    const events = [makeEvent({ uuid: "evt-1" }), makeEvent({ uuid: "evt-2", id: 2 })];
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse({ success: true, data: events })
    );
    // Empty second page to terminate pagination
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse({ success: true, data: [] })
    );

    const result = await fetchAllXceedEvents("test-api-key");
    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe("evt-1");
    expect(result[1].uuid).toBe("evt-2");
  });

  it("paginates correctly across multiple pages", async () => {
    // First page: PAGE_LIMIT items triggers another fetch
    const firstPage = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      makeEvent({ uuid: `evt-${i}`, id: i })
    );
    const secondPage = [makeEvent({ uuid: "evt-last", id: PAGE_LIMIT })];

    vi.mocked(fetch)
      .mockResolvedValueOnce(mockFetchResponse({ success: true, data: firstPage }))
      .mockResolvedValueOnce(mockFetchResponse({ success: true, data: secondPage }));

    const result = await fetchAllXceedEvents("test-api-key");
    expect(result).toHaveLength(PAGE_LIMIT + 1);
    expect(result[PAGE_LIMIT].uuid).toBe("evt-last");
  });

  it("handles bare array response (no data wrapper)", async () => {
    const events = [makeEvent()];
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(events));
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse([]));

    const result = await fetchAllXceedEvents("test-api-key");
    expect(result).toHaveLength(1);
  });

  it("sends X-Api-Key header on every request", async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ success: true, data: [] }));

    await fetchAllXceedEvents("my-secret-key");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/events"),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Api-Key": "my-secret-key" }),
      })
    );
  });
});

describe("fetchXceedBookingsPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns bookings, nextOffset, and isLastPage=false when full page returned", async () => {
    const bookings = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      makeBooking({ id: `booking-${i}` })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse({ success: true, data: bookings })
    );

    const result = await fetchXceedBookingsPage("api-key", 0);
    expect(result.bookings).toHaveLength(PAGE_LIMIT);
    expect(result.nextOffset).toBe(PAGE_LIMIT);
    expect(result.isLastPage).toBe(false);
  });

  it("returns isLastPage=true when fewer than PAGE_LIMIT items returned", async () => {
    const bookings = [makeBooking(), makeBooking({ id: "booking-2" })];
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse({ success: true, data: bookings })
    );

    const result = await fetchXceedBookingsPage("api-key", 200);
    expect(result.bookings).toHaveLength(2);
    expect(result.nextOffset).toBe(202);
    expect(result.isLastPage).toBe(true);
  });

  it("uses the provided offset in the request URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse({ success: true, data: [] }));

    await fetchXceedBookingsPage("api-key", 500);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("offset=500"),
      expect.anything()
    );
  });

  it("sends X-Api-Key header", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse({ success: true, data: [] }));

    await fetchXceedBookingsPage("my-key", 0);

    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Api-Key": "my-key" }),
      })
    );
  });

  it("returns empty bookings and isLastPage=true on non-retryable HTTP error (404)", async () => {
    // 404 is not retried (only 429 and 5xx are retried)
    vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse("Not Found", 404));

    const result = await fetchXceedBookingsPage("api-key", 0);
    expect(result.bookings).toHaveLength(0);
    expect(result.isLastPage).toBe(true);
  });
});

describe("fetchXceedBookingsFrom", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches all pages starting from the given offset", async () => {
    const firstPage = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      makeBooking({ id: `b-${i}` })
    );
    const secondPage = [makeBooking({ id: "b-last" })];

    vi.mocked(fetch)
      .mockResolvedValueOnce(mockFetchResponse({ success: true, data: firstPage }))
      .mockResolvedValueOnce(mockFetchResponse({ success: true, data: secondPage }));

    const result = await fetchXceedBookingsFrom("api-key", 0);
    expect(result.bookings).toHaveLength(PAGE_LIMIT + 1);
    expect(result.lastOffset).toBe(PAGE_LIMIT + 1);
  });

  it("returns correct lastOffset after partial page", async () => {
    const bookings = [makeBooking(), makeBooking({ id: "b-2" })];
    vi.mocked(fetch).mockResolvedValueOnce(
      mockFetchResponse({ success: true, data: bookings })
    );

    const result = await fetchXceedBookingsFrom("api-key", 300);
    expect(result.lastOffset).toBe(302);
  });
});

describe("fetchWithRetry (via fetchAllXceedEvents)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries on 429 with Retry-After header", async () => {
    const events = [makeEvent()];

    // 1 event < PAGE_LIMIT — pagination stops after success (no extra empty-page call)
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockFetchResponse(null, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(mockFetchResponse({ success: true, data: events }));

    const promise = fetchAllXceedEvents("api-key");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetch).toHaveBeenCalledTimes(2); // 429 + success (partial page → stop)
    expect(result).toHaveLength(1);
  });

  it("retries on 429 without Retry-After using backoff", async () => {
    const events = [makeEvent()];

    vi.mocked(fetch)
      .mockResolvedValueOnce(mockFetchResponse(null, 429))
      .mockResolvedValueOnce(mockFetchResponse({ success: true, data: events }));

    const promise = fetchAllXceedEvents("api-key");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetch).toHaveBeenCalledTimes(2); // 429 + success (partial page → stop)
    expect(result).toHaveLength(1);
  });

  it("retries on 500 server error with backoff", async () => {
    const events = [makeEvent()];

    vi.mocked(fetch)
      .mockResolvedValueOnce(mockFetchResponse("error", 500))
      .mockResolvedValueOnce(mockFetchResponse({ success: true, data: events }));

    const promise = fetchAllXceedEvents("api-key");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetch).toHaveBeenCalledTimes(2); // 500 + success (partial page → stop)
    expect(result).toHaveLength(1);
  });

  it("throws after MAX_RETRIES on persistent 429", async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse(null, 429));

    // Attach assertion BEFORE advancing timers so the rejection is always handled
    // and never floats as an unhandled promise rejection (vitest fake timer pattern)
    const assertionPromise = expect(fetchAllXceedEvents("api-key")).rejects.toThrow(
      /Rate limit \(429\) persisted after/
    );
    await vi.runAllTimersAsync();
    await assertionPromise;
  });

  it("throws after MAX_RETRIES on persistent 500", async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse("error", 500));

    // Attach assertion BEFORE advancing timers so the rejection is always handled
    const assertionPromise = expect(fetchAllXceedEvents("api-key")).rejects.toThrow(
      /Server error \(500\) persisted after/
    );
    await vi.runAllTimersAsync();
    await assertionPromise;
  });
});
