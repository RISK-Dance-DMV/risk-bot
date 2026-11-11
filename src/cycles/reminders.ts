/**
 * Session reminders. Pure.
 *
 * Two different messages to two different ends:
 *
 *   T−2  the session itself — when, where, who's leading, and whether it
 *        still has no room
 *   T−1  anything anyone wants looked at — the last useful moment to post a
 *        video, because after this the session has happened
 *
 * Both fire on a *date* comparison rather than an instant. A session is stored
 * as a local date and a wall-clock time, so "two days before" is a calendar
 * question; turning it into a timezone question would be inventing precision
 * the data doesn't have.
 */
import { parseIsoDate, type CycleSession } from "./cycle";

/** The day a reminder for this session falls due. */
export function remindOn(date: string, leadDays: number): string | null {
  const day = parseIsoDate(date);
  if (!day) return null;
  return new Date(day.getTime() - leadDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export type ReminderKind = "session" | "video";

/**
 * Whether this reminder is due today and hasn't gone out.
 *
 * Due *on* the day rather than from it onwards: a job that missed its window
 * should stay quiet rather than send "training in two days" the morning of.
 */
export function reminderDue(
  session: CycleSession,
  kind: ReminderKind,
  leadDays: number,
  now: Date,
): boolean {
  const sent = kind === "session" ? session.remindedSessionAt : session.remindedVideoAt;
  if (sent) return false;

  const today = now.toISOString().slice(0, 10);
  return remindOn(session.date, leadDays) === today;
}

export function dueReminders(
  sessions: readonly CycleSession[],
  kind: ReminderKind,
  leadDays: number,
  now: Date,
): CycleSession[] {
  return sessions
    .filter((s) => reminderDue(s, kind, leadDays, now))
    .sort((a, b) => a.date.localeCompare(b.date));
}
