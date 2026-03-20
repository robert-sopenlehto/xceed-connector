/**
 * @file client.ts
 * @description Xceed REST API client — stateless fetch helpers with pagination,
 *   rate-limit retry, and exponential backoff. Extracted from ads-uploader
 *   azure-functions (the most mature implementation, live-tested 2026-03-17).
 * @rationale Stateless module-level functions (not a class) keep the API surface
 *   minimal and avoid constructor overhead for consumers that call functions
 *   directly. apiKey is a parameter, not read from process.env, enabling
 *   multi-account use and straightforward unit testing.
 *
 * @decision DEC-XCEED-001
 * @title Xceed API REST client — stateless fetch helpers, apiKey as parameter
 * @status accepted
 * @rationale Direct REST access confirmed via live API testing. Auth: X-Api-Key
 *   header. Base URL: https://api.xceed.me/v1. Pagination: limit (max 100) +
 *   offset. Stateless functions accept apiKey as a parameter so that multiple
 *   accounts (BRUNCH_LISBOA, MOYG) can be served from the same package instance.
 *
 * @decision DEC-XCEED-010
 * @title Offset-based incremental sync (not watermark)
 * @status accepted
 * @rationale Xceed bookings API returns results OLDEST FIRST and supports
 *   offset+limit pagination. Storing last_offset in xceed.sync_state and
 *   resuming from there avoids re-fetching previously synced data. Overlap is
 *   safe because the downstream MERGE on booking_id handles duplicates.
 */

import type { XceedEvent, XceedBooking } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const XCEED_API_BASE = "https://api.xceed.me/v1";

/** Page size used for all paginated Xceed endpoints. */
export const PAGE_LIMIT = 100;

/** Minimum inter-request delay in milliseconds (rate limit courtesy). */
const INTER_REQUEST_DELAY_MS = 200;

/** Exponential backoff base delays for 429 retries (ms). */
const BACKOFF_DELAYS_MS: readonly number[] = [2000, 5000, 15000];

/** Maximum retry attempts for 429 / transient 5xx responses. */
const MAX_RETRIES = 10;

// ── Internal helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xceedHeaders(apiKey: string): Record<string, string> {
  return {
    "X-Api-Key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Fetch a single URL with retry logic for 429 (rate limited) and 5xx responses.
 *
 * On a 429, the Retry-After header is honoured if present; otherwise exponential
 * backoff from BACKOFF_DELAYS_MS is applied. Retries up to MAX_RETRIES times
 * before throwing.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempt = 0
): Promise<Response> {
  const response = await fetch(url, options);

  if (response.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `[xceed-api] Rate limit (429) persisted after ${MAX_RETRIES} retries: ${url}`
      );
    }
    const retryAfterHeader = response.headers.get("Retry-After");
    let delayMs: number;
    if (retryAfterHeader) {
      delayMs = parseInt(retryAfterHeader, 10) * 1000;
    } else {
      const backoffIndex = Math.min(attempt, BACKOFF_DELAYS_MS.length - 1);
      delayMs = BACKOFF_DELAYS_MS[backoffIndex];
    }
    console.warn(
      `[xceed-api] Rate limit hit (429) on attempt ${attempt + 1}/${MAX_RETRIES}, ` +
        `waiting ${delayMs}ms before retry: ${url}`
    );
    await sleep(delayMs);
    return fetchWithRetry(url, options, attempt + 1);
  }

  if (response.status >= 500) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `[xceed-api] Server error (${response.status}) persisted after ${MAX_RETRIES} retries: ${url}`
      );
    }
    const backoffIndex = Math.min(attempt, BACKOFF_DELAYS_MS.length - 1);
    const delayMs = BACKOFF_DELAYS_MS[backoffIndex];
    console.warn(
      `[xceed-api] Server error (${response.status}) on attempt ${attempt + 1}/${MAX_RETRIES}, ` +
        `waiting ${delayMs}ms before retry: ${url}`
    );
    await sleep(delayMs);
    return fetchWithRetry(url, options, attempt + 1);
  }

  return response;
}

/**
 * Perform a paginated GET against an Xceed endpoint.
 *
 * Xceed uses offset-based pagination: pass `offset` and `limit` query params.
 * The API returns results OLDEST FIRST. Pagination stops when a page returns
 * fewer than PAGE_LIMIT items (indicating the final page).
 *
 * @param apiKey      Xceed API key
 * @param path        API path, e.g. "/events" or "/bookings"
 * @param extraParams Additional query parameters to include on every page
 * @param startOffset Offset to begin from (default 0)
 * @returns All items fetched and the offset after the last item returned
 */
async function fetchAllPages<T>(
  apiKey: string,
  path: string,
  extraParams: Record<string, string> = {},
  startOffset = 0
): Promise<{ items: T[]; lastOffset: number }> {
  const headers = xceedHeaders(apiKey);
  const items: T[] = [];
  let offset = startOffset;

  while (true) {
    const params = new URLSearchParams({
      ...extraParams,
      offset: String(offset),
      limit: String(PAGE_LIMIT),
    });
    const url = `${XCEED_API_BASE}${path}?${params}`;

    const response = await fetchWithRetry(url, { headers });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "(unreadable body)");
      console.error(
        `[xceed-api] Fetch failed — HTTP ${response.status} for ${url}: ${bodyText}`
      );
      break;
    }

    const body = await response.json();

    // Xceed API wraps responses in {"success": true, "data": [...]}
    const page: T[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? body.data
        : [];

    if (!Array.isArray(body) && !Array.isArray(body?.data)) {
      console.error(
        `[xceed-api] Unexpected response shape (expected array or {data: array}) from ${url}`
      );
    }

    if (page.length === 0) {
      break;
    }

    items.push(...page);
    offset += page.length;

    if (page.length < PAGE_LIMIT) {
      // Final page — no more data
      break;
    }

    // Courtesy delay between pages to avoid saturating the rate limit
    await sleep(INTER_REQUEST_DELAY_MS);
  }

  return { items, lastOffset: offset };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch all Xceed events for the account associated with the provided API key.
 *
 * Paginates `/v1/events` with offset-based pagination until all events are
 * returned. The returned array preserves the API's ordering (oldest first).
 *
 * @param apiKey  Xceed API key (e.g. from XCEED_API_KEY_BRUNCH_LISBOA env var)
 */
export async function fetchAllXceedEvents(
  apiKey: string
): Promise<XceedEvent[]> {
  const { items } = await fetchAllPages<XceedEvent>(apiKey, "/events");
  return items;
}

/**
 * Fetch Xceed bookings incrementally, resuming from the stored offset.
 *
 * The Xceed bookings endpoint returns results OLDEST FIRST. The caller should
 * persist `lastOffset` in xceed.sync_state and pass it back on the next run so
 * that only new bookings are fetched.
 *
 * Overlap between runs is acceptable: the downstream MERGE statement uses
 * booking_id as the unique key and will upsert duplicates safely.
 *
 * @param apiKey      Xceed API key
 * @param startOffset Offset to resume from (default 0 = full re-fetch)
 * @returns bookings fetched this run and the new lastOffset to persist
 */
export async function fetchXceedBookingsFrom(
  apiKey: string,
  startOffset = 0
): Promise<{ bookings: XceedBooking[]; lastOffset: number }> {
  const { items, lastOffset } = await fetchAllPages<XceedBooking>(
    apiKey,
    "/bookings",
    {},
    startOffset
  );
  return { bookings: items, lastOffset };
}

/**
 * Fetch a single page of Xceed bookings at the given offset.
 *
 * Returns the page of bookings and the next offset. If the page has fewer than
 * PAGE_LIMIT items, this is the last page and `isLastPage` will be true.
 *
 * Used by syncXceedData for page-by-page processing with offset saved after each
 * page, so the Azure Function time-box does not restart progress from 0.
 *
 * @param apiKey  Xceed API key
 * @param offset  Offset to fetch from
 * @returns bookings on this page, next offset, and whether this is the final page
 */
export async function fetchXceedBookingsPage(
  apiKey: string,
  offset: number
): Promise<{ bookings: XceedBooking[]; nextOffset: number; isLastPage: boolean }> {
  const headers = xceedHeaders(apiKey);
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(PAGE_LIMIT),
  });
  const url = `${XCEED_API_BASE}/bookings?${params}`;

  const response = await fetchWithRetry(url, { headers });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "(unreadable body)");
    console.error(
      `[xceed-api] Fetch failed — HTTP ${response.status} for ${url}: ${bodyText}`
    );
    return { bookings: [], nextOffset: offset, isLastPage: true };
  }

  const body = await response.json();
  const page: XceedBooking[] = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : [];

  return {
    bookings: page,
    nextOffset: offset + page.length,
    isLastPage: page.length < PAGE_LIMIT,
  };
}
