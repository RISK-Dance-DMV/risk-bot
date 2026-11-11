/**
 * Training cycles (design doc rank 7, reordered). Pure.
 *
 * Cycles are calendar-aligned two-month blocks — Jan/Feb, Mar/Apr, May/Jun,
 * Jul/Aug, Sep/Oct — **skipping Nov/Dec**.
 *
 * Two departures from the doc, both deliberate:
 *
 *   - The first cycle is set by hand with `/cycle start`. The doc computes
 *     every cycle from a stored sequence position, which assumes the sequence
 *     was ever clean; the one RISK is in now isn't, and a bootstrap command is
 *     honest about that where a fudged offset wouldn't be.
 *
 *   - The prompt fires a configurable number of days before the *current*
 *     cycle ends, rather than 30 days before the *next* one starts. Same
 *     moment in a tidy sequence, but it still works when a cycle has been
 *     stretched or cut short, which is the case that actually happens.
 */

/**
 * What a cycle is *about*. Exactly one per cycle — the point is that a block of
 * eight weeks trains one thing, so a cycle with two focuses has neither.
 */
export const CYCLE_FOCUSES = [
  "Isolations & Body Control",
  "Power & Dynamics",
  "Lines & Pictures",
  "Groove",
  "Footwork",
] as const;

export type CycleFocus = (typeof CYCLE_FOCUSES)[number];

export function isCycleFocus(value: string): value is CycleFocus {
  return (CYCLE_FOCUSES as readonly string[]).includes(value);
}

/** Months a cycle may begin in, 1-indexed. Nov/Dec is the gap. */
export const CYCLE_START_MONTHS = [1, 3, 5, 7, 9] as const;

const MONTH_NAMES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

export type CycleStatus =
  /** Proposed; the coach is settling which dates to ask about. */
  | "draft"
  /** Waiting on trainees to answer the availability poll. */
  | "polling"
  /** Poll closed; the coach is picking dates and times. */
  | "scheduling"
  /** Running. */
  | "active"
  | "closed";

import type { SessionBooking } from "./booking";

export interface CycleSession {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24h, local to config:timezone. */
  start: string;
  end: string;
  /**
   * Who's leading this one, as typed. A cycle has a main coach, but coaches
   * cover for each other, and "who was actually there" is the thing people
   * reconstruct wrongly a month later.
   *
   * Stored raw so a Discord mention stays a mention and a plain name stays a
   * name — both render correctly without the bot having to resolve anything.
   */
  lead?: string;
  /** How many said they could make it — from the poll, or from attendees. */
  votes?: number;
  /** Set once a room is booked for it (rank 9). */
  booking?: SessionBooking;
  /** Stamps so each reminder goes out once, not every morning. */
  remindedSessionAt?: string;
  remindedVideoAt?: string;
  /**
   * Who is expected. Free text until there's a Trainees table to resolve
   * against; recorded because a cost split needs a headcount and "who was
   * called" is the thing people forget by the following week.
   */
  attendees?: string[];
}

export interface CycleDeadline {
  date: string;
  title: string;
}

export interface CycleRecord {
  cycleId: string;
  /** "SEP–OCT 2026" */
  name: string;
  startsOn: string;
  endsOn: string;
  /**
   * True when a human set startsOn/endsOn rather than them being inferred from
   * the sessions. A cycle often starts before its first practice — a learning
   * week, choreo drops — and that start is a fact about the cycle, not
   * something to be recomputed every time the schedule is edited.
   */
  datesDeclared?: boolean;
  status: CycleStatus;
  coachDiscordId?: string;
  /** One of CYCLE_FOCUSES. */
  focus?: string;
  choreo?: string;
  sessions?: CycleSession[];
  deadlines?: CycleDeadline[];

  /** The availability poll, while there is one. */
  pollMessageId?: string;
  pollChannelId?: string;
  pollClosesAt?: string;
  /** Dates the poll offered, in order, so answers can be mapped back. */
  pollDates?: string[];
  /**
   * What the poll came back with. Stored rather than re-read, so [Use these
   * dates] can open a prefilled modal inside the 3s a modal has to answer in —
   * fetching voters per answer would never make it.
   */
  pollResults?: { date: string; names: string[] }[];
  /** The block this cycle would occupy, before the schedule narrows it. */
  proposedStartsOn?: string;
  proposedEndsOn?: string;

  /** Set once the next cycle has been proposed, so it's proposed once. */
  nextPromptedAt?: string;
  /** When the booking list was last posted, so a daily run doesn't nag daily. */
  bookingPostedAt?: string;
  /** Set once the audition window has been announced, so it's announced once. */
  auditionsAnnouncedAt?: string;
  createdBy?: string;
  createdAt?: string;
  closedAt?: string;
}

// ------------------------------------------------------------- date helpers

function utc(year: number, month1: number, day: number): Date {
  return new Date(Date.UTC(year, month1 - 1, day));
}

/** YYYY-MM-DD, which is how every date in a cycle is stored. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The last day of a month, so a block's end never lands on the 31st of April. */
function lastDayOf(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * The block that follows a given one.
 *
 * Sep/Oct rolls to Jan/Mar of next year rather than Nov/Dec — the gap is the
 * one thing about this sequence people get wrong from memory.
 */
export function nextBlockAfter(startsOn: string): { startsOn: string; endsOn: string } | null {
  const start = parseIsoDate(startsOn);
  if (!start) return null;

  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;

  // The next start month in the sequence, or January of next year.
  const later = CYCLE_START_MONTHS.find((m) => m > month);
  const nextYear = later ? year : year + 1;
  const nextMonth = later ?? CYCLE_START_MONTHS[0];

  const endMonth = nextMonth + 1;
  return {
    startsOn: isoDate(utc(nextYear, nextMonth, 1)),
    endsOn: isoDate(utc(nextYear, endMonth, lastDayOf(nextYear, endMonth))),
  };
}

/** "SEP–OCT 2026". An en dash, because that's what a range takes. */
export function cycleName(startsOn: string): string {
  const start = parseIsoDate(startsOn);
  if (!start) return "";
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  return `${MONTH_NAMES[month]}–${MONTH_NAMES[(month + 1) % 12]} ${year}`;
}

/** Stable and readable: "2026-sep-oct". */
export function cycleIdFor(startsOn: string): string {
  return cycleName(startsOn).toLowerCase().replace("–", "-").split(" ").reverse().join("-");
}

/**
 * Every Saturday in the block, which is what the poll offers.
 *
 * A native Discord poll caps at 10 answers and a two-month block never has
 * more than 9 Saturdays, so the whole block always fits — but the cap is
 * checked rather than assumed, because a stretched cycle would break it
 * silently.
 */
export function saturdaysBetween(startsOn: string, endsOn: string): string[] {
  const start = parseIsoDate(startsOn);
  const end = parseIsoDate(endsOn);
  if (!start || !end || start > end) return [];

  const out: string[] = [];
  const cursor = new Date(start);
  // 6 = Saturday.
  cursor.setUTCDate(cursor.getUTCDate() + ((6 - cursor.getUTCDay() + 7) % 7));

  while (cursor <= end) {
    out.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

/** "Sat 12 Sep" — a label, not an instant, so no timezone is involved. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatCycleDate(value: string): string {
  const date = parseIsoDate(value);
  if (!date) return value;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}`;
}

// ------------------------------------------------------------ prompt timing

/**
 * Whether it's time to propose the next cycle.
 *
 * Counted back from the end of the cycle running now. Fires once — the record
 * carries the stamp — because a coach who hasn't answered yet doesn't need
 * asking again every morning.
 */
export function needsNextCyclePrompt(
  cycle: CycleRecord,
  promptDays: number,
  now: Date,
): boolean {
  if (cycle.status !== "active" || cycle.nextPromptedAt) return false;
  const end = parseIsoDate(cycle.endsOn);
  if (!end) return false;

  const promptFrom = end.getTime() - promptDays * 24 * 60 * 60 * 1000;
  return now.getTime() >= promptFrom;
}

/** A cycle whose end has passed and which nothing has closed yet. */
export function isOverdueToClose(cycle: CycleRecord, now: Date): boolean {
  if (cycle.status !== "active") return false;
  const end = parseIsoDate(cycle.endsOn);
  return !!end && now.getTime() > end.getTime() + 24 * 60 * 60 * 1000;
}

// ------------------------------------------------------------- validation

export type CycleDatesResult =
  | { ok: true; startsOn: string; endsOn: string }
  | { ok: false; reason: string };

/** The bootstrap command's input, checked rather than trusted. */
export function validateCycleDates(startsOn: string, endsOn: string): CycleDatesResult {
  const start = parseIsoDate(startsOn.trim());
  const end = parseIsoDate(endsOn.trim());

  if (!start) return { ok: false, reason: "Start date must be YYYY-MM-DD." };
  if (!end) return { ok: false, reason: "End date must be YYYY-MM-DD." };
  if (end <= start) return { ok: false, reason: "The end has to come after the start." };

  const days = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
  if (days > 200) {
    return { ok: false, reason: "That's longer than six months — check the dates." };
  }

  return { ok: true, startsOn: isoDate(start), endsOn: isoDate(end) };
}

// --------------------------------------------------------- manual scheduling

/** What a session defaults to when the line doesn't say. Doc §0c's standard. */
export const DEFAULT_SESSION_START = "10:15";
export const DEFAULT_SESSION_END = "12:15";

export type SessionParseResult =
  | { ok: true; sessions: CycleSession[] }
  | { ok: false; reason: string };

/**
 * One session per line, for a cycle scheduled without a poll:
 *
 *   2027-01-02 10:15-12:15 Ashna | Mimi, Tay  ← lead, then who's coming
 *   2027-01-09 11:00-13:00 | 8                ← just a headcount
 *   2027-01-16 Alina                          ← times default, lead given
 *   2027-01-23                                ← nothing but the date
 *
 * Either side of the pipe is accepted because both are real: a coach reading a
 * reaction poll has counts and no names, and a coach who called specific people
 * has names and no need to count them.
 *
 * Names are free text on purpose. There is no Trainees table to resolve them
 * against (rank 7's own data model, not built), and a name that doesn't resolve
 * is more useful written down than rejected.
 */
export function parseSessionLines(text: string): SessionParseResult {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return { ok: false, reason: "Add at least one session." };

  const sessions: CycleSession[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const [left, right] = line.split("|");
    const parts = (left ?? "").trim().split(/\s+/);
    const date = parts[0] ?? "";

    if (!parseIsoDate(date)) {
      return { ok: false, reason: `\`${line}\` — the date must start the line, as YYYY-MM-DD.` };
    }
    if (seen.has(date)) {
      return { ok: false, reason: `${formatCycleDate(date)} is listed twice.` };
    }
    seen.add(date);

    // The times are optional, so whatever follows the date is either a time
    // range or the start of the lead's name — decided by shape, not position.
    let start = DEFAULT_SESSION_START;
    let end = DEFAULT_SESSION_END;
    let rest = parts.slice(1);

    const times = (rest[0] ?? "").match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (times) {
      start = (times[1] as string).padStart(5, "0");
      end = (times[2] as string).padStart(5, "0");
      if (end <= start) {
        return { ok: false, reason: `${formatCycleDate(date)} ends before it starts.` };
      }
      rest = rest.slice(1);
    } else if (rest[0] && /^\d/.test(rest[0])) {
      // Starts with a digit but isn't a time range — almost always a typo in
      // the times rather than somebody named "11-1".
      return { ok: false, reason: `\`${rest[0]}\` isn't a time range. Use 11:00-13:00.` };
    }

    const lead = rest.join(" ").trim();

    const tail = (right ?? "").trim();
    const bareCount = /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : null;
    const attendees = bareCount === null
      ? tail.split(",").map((name) => name.trim()).filter(Boolean)
      : [];

    sessions.push({
      date,
      start,
      end,
      ...(lead ? { lead } : {}),
      ...(bareCount !== null ? { votes: bareCount } : {}),
      ...(attendees.length > 0 ? { attendees, votes: attendees.length } : {}),
    });
  }

  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, sessions };
}

/** The span a set of sessions covers, for a cycle whose dates follow its schedule. */
export function sessionSpan(
  sessions: readonly CycleSession[],
): { startsOn: string; endsOn: string } | null {
  if (sessions.length === 0) return null;
  const dates = sessions.map((s) => s.date).sort();
  return { startsOn: dates[0] as string, endsOn: dates[dates.length - 1] as string };
}

/**
 * The dates a cycle runs, given what was declared and what the sessions say.
 *
 * Declared dates win where they're wider — a learning week with no session is
 * still part of the cycle, and that's the whole reason not to just take the
 * span. But they only win if they still *describe* the sessions: a schedule
 * replaced with dates outside the old range means the cycle moved, and keeping
 * the old header there leaves a card claiming January over a list of October.
 */
export function cycleRangeFor(
  declared: { startsOn: string; endsOn: string },
  span: { startsOn: string; endsOn: string },
  wasDeclared = false,
): { startsOn: string; endsOn: string } {
  // Dates somebody stated are never thrown away, only widened to fit a session
  // that falls outside them. Editing the schedule is not a claim about when the
  // cycle began.
  if (wasDeclared) {
    return {
      startsOn: span.startsOn < declared.startsOn ? span.startsOn : declared.startsOn,
      endsOn: span.endsOn > declared.endsOn ? span.endsOn : declared.endsOn,
    };
  }

  const overlaps = span.startsOn <= declared.endsOn && span.endsOn >= declared.startsOn;
  if (!overlaps) return span;

  return {
    startsOn: span.startsOn < declared.startsOn ? span.startsOn : declared.startsOn,
    endsOn: span.endsOn > declared.endsOn ? span.endsOn : declared.endsOn,
  };
}

/**
 * When audition proposals open and close, per design doc §12.
 *
 * Counted back from the cycle's end rather than forward from its start: the
 * point of the window is to leave time between a proposal and the end of the
 * cycle, so a coach can ask for a different song and the trainee can still
 * learn it.
 */
export function auditionWindow(
  cycle: { endsOn: string },
  openDays: number,
  closeDays: number,
): { opensOn: string; closesOn: string } | null {
  const end = parseIsoDate(cycle.endsOn);
  if (!end) return null;
  const back = (days: number) =>
    new Date(end.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { opensOn: back(openDays), closesOn: back(closeDays) };
}