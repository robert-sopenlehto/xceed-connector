/**
 * @file types.ts
 * @description TypeScript interfaces for all Xceed API response shapes and
 *   package-level sync options/result types.
 * @rationale Canonical types extracted from ads-uploader (most complete, live-tested
 *   implementation). Kept in a separate file so consumers can import only the type
 *   definitions without pulling in client or SQL runtime dependencies.
 *
 * @decision DEC-XCEED-001
 * @title Xceed API REST client — stateless fetch helpers, apiKey as parameter
 * @status accepted
 * @rationale Stateless functions accept apiKey as a parameter rather than reading
 *   from process.env. Enables multi-account use (each consumer passes its own key)
 *   and makes unit testing straightforward without environment variable setup.
 *
 * @decision DEC-PKG-003
 * @title SQL upsert helpers accept mssql ConnectionPool (not abstracted)
 * @status accepted
 * @rationale All three consumers use mssql against Azure SQL. Abstracting to a
 *   generic interface adds complexity without value. XceedSyncOptions takes a
 *   ConnectionPool directly to keep the dependency surface explicit.
 */

import type { ConnectionPool } from "mssql";

export interface XceedVenue {
  uuid: string;
  name: string;
}

export interface XceedVenueDetail {
  uuid: string;
  name: string;
  city?: string | { id?: string | number; name: string; slug?: string; [key: string]: unknown };
  country?: string;
}

export interface XceedEvent {
  id: number;
  uuid: string;
  name: string;
  startingTime: number;
  endingTime: number;
  venue: XceedVenue;
  ticketsSold: number;
}

export interface XceedPass {
  id: string;
  barcode?: string;
  status?: string;
  [key: string]: unknown;
}

export interface XceedOffer {
  id: string;
  type: string;
  name: string;
  description: string;
  price: {
    amount: string;
    onlinePrice: number;
    offlinePrice: number;
    currency: string;
  };
}

export interface XceedBuyer {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
}

export interface XceedBooking {
  id: string;
  legacyId: number;
  buyer: XceedBuyer;
  quantity: number;
  passes: XceedPass[];
  event: {
    id: string;
    legacyId: number;
    name: string;
    slug: string;
    startingTime: number;
    endingTime: number;
    venue: XceedVenueDetail;
    [key: string]: unknown;
  };
  offer: XceedOffer;
  channel: string | { id?: string; name: string; slug?: string; legacyId?: number; [key: string]: unknown };
  purchasedAt: number;
  confirmed: boolean;
  [key: string]: unknown;
}

export interface XceedSyncOptions {
  apiKey: string;
  pool: ConnectionPool;
  accountLabel: string;
  timeBoxMs?: number;
  onProgress?: (message: string) => void;
}

export interface XceedSyncResult {
  eventsCount: number;
  bookingsCount: number;
  offersCount: number;
  finalOffset: number;
  timeBoxReached: boolean;
}
