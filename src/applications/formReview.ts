/**
 * Twice a year, asks the directors to look at the two forms before a round of
 * applications arrives on them.
 *
 * **Why a reminder rather than a check.** Nothing in here can tell whether a
 * question is still the right question — that's judgement about what you want
 * to ask dancers this half. What a job *can* do is pick the moment, and the
 * moment matters: a form reviewed after applications start arriving has already
 * collected answers in the old shape.
 *
 * The one mechanical thing it can carry is the trap. `src/config/columns.ts`
 * maps the sheet's columns to fields, so adding or moving a question breaks
 * intake until that file is updated with it. The existing alert for that fires
 * *after* the break, which is the wrong end of the problem — this says it
 * before anyone touches anything.
 */
import { isEnabled } from "../config/flags";
import { alertDirectors } from "../discord/rest";
import type { Env } from "../env";

/**
 * November 15 and June 15, a month or so ahead of each intake.
 *
 * In code rather than KV because they are not a parameter anybody tunes — they
 * are the shape of the year, like the Jan 1 / Jul 1 enforcement dates. Move
 * them by editing them.
 */
const REVIEW_DAYS = [
  { month: 10, day: 15 }, // November
  { month: 5, day: 15 }, // June
] as const;

/**
 * How late the reminder may still go out.
 *
 * Fires on the day or within the week after, rather than on the day alone: a
 * cron that missed Saturday because the Worker was down should still say
 * something on Monday. A reminder to look at a form is useful late and useless
 * never — unlike a deadline warning, where arriving late is worse than silence.
 */
const GRACE_DAYS = 7;

export interface FormReviewResult {
  skipped?: "flag_off";
  /** The occurrence it reminded about, if it did: `2026-11`. */
  reminded?: string;
}

/** `2026-11` — one marker per occurrence, so each fires once a year. */
function occurrenceOf(now: Date): string | undefined {
  for (const { month, day } of REVIEW_DAYS) {
    const due = Date.UTC(now.getUTCFullYear(), month, day);
    const since = now.getTime() - due;
    if (since >= 0 && since < GRACE_DAYS * 24 * 60 * 60 * 1000) {
      return `${now.getUTCFullYear()}-${String(month + 1).padStart(2, "0")}`;
    }
  }
  return undefined;
}

export async function runFormReview(
  env: Env,
  now = new Date(),
): Promise<FormReviewResult> {
  if (!(await isEnabled(env, "applications"))) return { skipped: "flag_off" };

  const occurrence = occurrenceOf(now);
  if (!occurrence) return {};

  const key = `applications:form-review:${occurrence}`;
  if (await env.KV.get(key)) return {};

  await alertDirectors(
    env,
    `📋 **Worth a look at the two forms before the next round of applications.**\n\n` +
      `The **application form** and the **audition form** — questions still the ` +
      `ones you want to ask, wording still right, anything to add or drop from ` +
      `last time.\n\n` +
      `⚠️ **If you add, remove or reorder a question, \`src/config/columns.ts\` ` +
      `needs updating to match.** The sheet is read by column, so a shifted ` +
      `form means applications stop being read correctly — you'd get told, but ` +
      `only once something had already come through wrong.\n\n` +
      `Nothing to do in the bot. This is the only reminder about it until the ` +
      `next one.`,
  );

  // Written after the post, so a failed alert is retried tomorrow rather than
  // marked done. `alertDirectors` swallows its own errors, so this is the
  // weaker guarantee of the two — but a reminder sent twice is a far smaller
  // problem than one silently skipped for six months.
  await env.KV.put(key, now.toISOString());
  return { reminded: occurrence };
}
