/**
 * Reminders that are a date in the year rather than a fact about a record.
 *
 * Everything else the daily jobs do is driven by rows and records — somebody
 * applied, somebody's window is closing, somebody's membership is up. These
 * are the other kind: twice a year the directors have to change something
 * outside the bot, and the only thing a job can do about it is pick the moment
 * and say so.
 *
 * **Two stages per subject, because the two jobs are different.** Deciding what
 * to change wants a couple of weeks; making the change wants to happen on one
 * particular day and not before. A single reminder has to choose which of those
 * it is, and whichever it chooses it gets the other one wrong — "think about
 * this" on the day is too late, and "do it now" a fortnight early gets done in
 * the wrong window or not at all.
 */
import { alertDirectors } from "../discord/rest";
import type { Env } from "../env";

/** A day in the year. `month` is 0-based, the way `Date.UTC` takes it. */
export interface YearlyDay {
  month: number;
  day: number;
}

/**
 * One nudge in a subject's schedule.
 *
 * `name` goes into the KV marker, so it is part of the stored state: renaming a
 * stage makes its past occurrences unseen and fires it again.
 */
export interface YearlyStage {
  name: string;
  days: readonly YearlyDay[];
  message: string;
}

/**
 * How late a reminder may still go out.
 *
 * Fires on the day or within the week after, rather than on the day alone: a
 * cron that missed Saturday because the Worker was down should still say
 * something on Monday. These are useful late and useless never — unlike a
 * deadline warning, where arriving late is worse than silence.
 *
 * It does mean no stage may sit within this many days of New Year's Eve: the
 * due date is computed in `now`'s own year, so a 28 December stage read on 2
 * January would look like a date still to come and be skipped. Nothing here is
 * close, and a stage that needed to be would need the previous year checked too.
 */
const GRACE_DAYS = 7;

export interface YearlyResult {
  /** Which stages fired, as `think:2026-11`. Absent when none did. */
  reminded?: string[];
}

/**
 * Which occurrence of these days is due, as `2026-11`.
 *
 * Keyed by year and month rather than the full date so that moving a stage
 * within its month doesn't re-fire one that already went out.
 */
export function dueOccurrence(
  days: readonly YearlyDay[],
  now: Date,
  graceDays: number = GRACE_DAYS,
): string | undefined {
  for (const { month, day } of days) {
    const due = Date.UTC(now.getUTCFullYear(), month, day);
    const since = now.getTime() - due;
    if (since >= 0 && since < graceDays * 24 * 60 * 60 * 1000) {
      return `${now.getUTCFullYear()}-${String(month + 1).padStart(2, "0")}`;
    }
  }
  return undefined;
}

/**
 * Posts whichever stages are due and haven't gone out, once each.
 *
 * Every due stage is considered rather than returning at the first: the
 * schedules here keep their stages weeks apart, but a schedule that didn't
 * would drop one silently, and a reminder that quietly never arrives is the
 * failure this whole mechanism exists to avoid.
 */
export async function runYearlyReminders(
  env: Env,
  keyPrefix: string,
  stages: readonly YearlyStage[],
  now: Date,
): Promise<YearlyResult> {
  const reminded: string[] = [];

  for (const stage of stages) {
    const occurrence = dueOccurrence(stage.days, now);
    if (!occurrence) continue;

    const key = `${keyPrefix}:${stage.name}:${occurrence}`;
    if (await env.KV.get(key)) continue;

    await alertDirectors(env, stage.message);
    // Written after the post, so a failed alert is retried tomorrow rather
    // than marked done. `alertDirectors` swallows its own errors, so this is
    // the weaker guarantee of the two — but a reminder sent twice is a far
    // smaller problem than one silently skipped for six months.
    await env.KV.put(key, now.toISOString());
    reminded.push(`${stage.name}:${occurrence}`);
  }

  return reminded.length > 0 ? { reminded } : {};
}
