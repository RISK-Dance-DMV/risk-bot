/**
 * Interview records and slot handling (design doc rank 24). Pure, and imports
 * nothing - the card renders these, and the flow that creates them imports the
 * card, so they can't live together.
 */

/** What RISK actually books. Prefills the modal; a director can override it. */
export const DEFAULT_MINUTES = 60;

/**
 * `drafted` is not one of the doc's statuses. It is the gap between writing an
 * invitation and it actually going out - visible on purpose, and named for what
 * has happened rather than what is intended, so an offer that was never sent
 * can't be mistaken for one that was.
 */
export type InterviewState = "drafted" | "offered" | "scheduled";

export interface InterviewRecord {
  state: InterviewState;
  date: string;
  time: string;
  durationMinutes: number;
  note?: string;
  draftedBy: string;
  draftedAt: string;
  draftId?: string;
  offeredAt?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  eventId?: string;
  /** Set when the time actually booked differs from the one that was offered. */
  rescheduledFrom?: { date: string; time: string };
}

export type SlotResult =
  | { ok: true; date: string; time: string; durationMinutes: number }
  | { ok: false; reason: string };

export function validateSlot(date: string, time: string, duration: string): SlotResult {
  const d = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { ok: false, reason: `Date must look like 2026-09-20; got "${date.trim()}".` };
  }
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== day
  ) {
    return { ok: false, reason: `There is no such date as ${d}.` };
  }

  const t = time.trim();
  const clock = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!clock) {
    return { ok: false, reason: `Time must look like 14:30; got "${t}".` };
  }
  const hh = Number(clock[1]);
  const mm = Number(clock[2]);
  if (hh > 23 || mm > 59) {
    return { ok: false, reason: `There is no such time as ${t}.` };
  }

  const raw = duration.trim();
  const minutes = raw ? Number(raw) : DEFAULT_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) {
    return { ok: false, reason: `Duration must be a whole number of minutes, 1–480; got "${raw}".` };
  }

  return {
    ok: true,
    date: d,
    time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    durationMinutes: minutes,
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Formats the literal date and time the director typed. Built without Intl so
 * the output doesn't drift with locale or the runtime's timezone - this is a
 * label, not an instant.
 */
export function formatSlot(date: string, time: string): string {
  const [y, m, day] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const at = new Date(Date.UTC(y, m - 1, day));
  const hour12 = ((hh + 11) % 12) + 1;
  const suffix = hh < 12 ? "am" : "pm";
  return `${WEEKDAYS[at.getUTCDay()]} ${day} ${MONTHS[m - 1]} ${y}, ${hour12}:${String(mm).padStart(2, "0")}${suffix}`;
}

export function renderInterviewLine(interview: InterviewRecord): string {
  const slot = formatSlot(interview.date, interview.time);
  switch (interview.state) {
    case "drafted":
      return `📅 **Interview drafted** for ${slot} — ⚠️ not offered yet; approve the draft to send it.`;
    case "offered":
      return `📅 **Interview offered** for ${slot} — invitation sent, waiting on their reply.`;
    case "scheduled": {
      const moved = interview.rescheduledFrom
        ? ` (moved from ${formatSlot(interview.rescheduledFrom.date, interview.rescheduledFrom.time)})`
        : "";
      return `📅 **Interview scheduled** for ${slot}${moved} — calendar invite sent.`;
    }
  }
}

/**
 * How far the named zone was from UTC at a given instant, in ms.
 *
 * Reads the wall clock the zone showed at that instant and subtracts. Workers
 * ship full ICU, so Intl knows the zone's real DST history rather than a fixed
 * offset.
 */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));

  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    at("hour"),
    at("minute"),
    at("second"),
  );
  return asIfUtc - instant;
}

/**
 * The instant a typed slot refers to.
 *
 * A director types "2:30pm" meaning 2:30pm here, not 2:30pm UTC. Appending a
 * `Z` and calling it done shifts the moment by the offset — four hours in
 * summer — which is invisible in formatSlot's label and very visible in a
 * Discord timestamp, since Discord renders in each viewer's own zone.
 *
 * Two passes because the offset at the guessed instant can differ from the
 * offset at the true one: on a DST changeover the first guess lands on the
 * wrong side of the boundary and would be an hour out.
 */
export function slotInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];

  const wallClock = Date.UTC(y, m - 1, d, hh, mm, 0);
  let instant = wallClock - zoneOffsetMs(wallClock, timeZone);
  instant = wallClock - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}
