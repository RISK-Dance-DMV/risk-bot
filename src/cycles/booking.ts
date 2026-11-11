/**
 * The trainee booking window (design doc rank 9). Pure.
 *
 * The library opens 30 days out, so a session becomes bookable 30 days before
 * it happens and stays bookable until it's booked or gone. The doc calls a
 * missed window "the one deadline in the system that money can't fix
 * afterward" — once the day passes, the session is simply lost.
 *
 * Two departures from the doc, both deliberate:
 *
 *   - Bookings live on the session in the cycle record, not in the Bookings
 *     sheet. That sheet is the join key for *dance* settlement, which isn't
 *     built; a trainee session already has a home, and giving it a second one
 *     would mean keeping them in step for no present gain.
 *
 *   - Checked daily rather than on a Thursday cron. The doc picks Thursday
 *     because that's when a Saturday crosses the 30-day line, which is true
 *     until a cycle has a session on some other day — and yours does. Daily
 *     can't miss one.
 */
import type { CycleSession } from "./cycle";
import { parseIsoDate } from "./cycle";

export type VenueType = "library" | "studio" | "free";

export const VENUE_TYPES: VenueType[] = ["library", "studio", "free"];

export interface SessionBooking {
  venue: string;
  room: string;
  venueType: VenueType;
  /** Whole currency units. 0 for a free room, which is still worth recording. */
  cost: number;
  bookedBy: string;
  bookedAt: string;
}

/** The day a session becomes bookable. */
export function windowOpensOn(date: string, leadDays: number): string | null {
  const day = parseIsoDate(date);
  if (!day) return null;
  return new Date(day.getTime() - leadDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Whether a session can be booked right now.
 *
 * Past sessions are excluded rather than reported: nothing can be done about
 * them, and a list that keeps naming them trains people to ignore the list.
 */
export function isBookable(
  session: CycleSession,
  leadDays: number,
  now: Date,
): boolean {
  if (session.booking) return false;

  const day = parseIsoDate(session.date);
  if (!day) return false;

  const today = now.toISOString().slice(0, 10);
  if (session.date < today) return false;

  const opens = windowOpensOn(session.date, leadDays);
  return opens !== null && opens <= today;
}

export function bookableSessions(
  sessions: readonly CycleSession[],
  leadDays: number,
  now: Date,
): CycleSession[] {
  return sessions
    .filter((s) => isBookable(s, leadDays, now))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * What each attending trainee would pay.
 *
 * Null rather than zero when nobody is expected — dividing by an unknown gives
 * a confident wrong number, and the doc wants "—" in that case. A genuinely
 * free room divides to 0, which is a real answer.
 */
export function costEstimate(cost: number, expected: number | undefined): number | null {
  if (expected === undefined || expected <= 0) return null;
  return cost / expected;
}

export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export type BookingInput = {
  venue: string;
  room: string;
  venueType: string;
  cost: string;
};

export type BookingResult =
  | { ok: true; booking: Omit<SessionBooking, "bookedBy" | "bookedAt"> }
  | { ok: false; reason: string };

export function validateBooking(input: BookingInput): BookingResult {
  const venue = input.venue.trim();
  if (!venue) return { ok: false, reason: "A booking needs a venue." };

  const type = input.venueType.trim().toLowerCase();
  if (!VENUE_TYPES.includes(type as VenueType)) {
    return { ok: false, reason: `Venue type must be one of: ${VENUE_TYPES.join(", ")}.` };
  }

  const raw = input.cost.trim().replace(/^\$/, "");
  // A free room is 0, not blank — completeness is what makes the cost split
  // work, and a missing number reads the same as an unrecorded booking.
  const cost = raw === "" ? 0 : Number.parseFloat(raw);
  if (!Number.isFinite(cost) || cost < 0) {
    return { ok: false, reason: `\`${input.cost}\` isn't a cost. Use a number, or 0 for free.` };
  }

  return {
    ok: true,
    booking: { venue, room: input.room.trim(), venueType: type as VenueType, cost },
  };
}

/** How long a session has been sitting bookable and unbooked. */
export function daysWaiting(session: CycleSession, leadDays: number, now: Date): number {
  const opens = windowOpensOn(session.date, leadDays);
  if (!opens) return 0;
  const openedAt = parseIsoDate(opens);
  if (!openedAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - openedAt.getTime()) / (24 * 60 * 60 * 1000)));
}
