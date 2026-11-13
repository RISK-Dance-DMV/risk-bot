/**
 * Twice a year, asks the directors to look at the two forms — once to decide
 * what to change, and once to change it.
 *
 * **Why a reminder rather than a check.** Nothing in here can tell whether a
 * question is still the right question — that's judgement about what you want
 * to ask dancers this half. What a job *can* do is pick the moment, and the
 * moment matters in a way that is particular to forms: the sheet behind one is
 * read by column position, so editing a form while it is still open changes the
 * shape of the rows arriving into it.
 *
 * Which is why the second stage lands on the day the form closes rather than
 * the day the decision was made. The bot has no idea when that is — the close
 * is something you do in Google Forms — so these dates are the only place the
 * two halves of the year are written down on this side.
 */
import { isEnabled } from "../config/flags";
import { runYearlyReminders, type YearlyResult, type YearlyStage } from "../config/yearly";
import type { Env } from "../env";

export interface FormReviewResult extends YearlyResult {
  skipped?: "flag_off";
}

/**
 * The columns trap, in full.
 *
 * Carried on the stage that lands when someone is about to edit, because the
 * existing alert for a shifted sheet fires *after* intake has broken, which is
 * the wrong end of the problem.
 */
const COLUMNS =
  `⚠️ **If you add, remove or reorder a question, \`src/config/columns.ts\` ` +
  `needs updating to match.** The sheet is read by column, so a shifted form ` +
  `means applications stop being read correctly — you'd get told, but only ` +
  `once something had already come through wrong.`;

/**
 * Mid-November and mid-May to decide, the first of December and of June to do
 * it.
 *
 * In code rather than KV because they are not a parameter anybody tunes — they
 * are the shape of the year, like the Jan 1 / Jul 1 enforcement dates. Move
 * them by editing them.
 */
const STAGES: readonly YearlyStage[] = [
  {
    name: "think",
    days: [
      { month: 10, day: 15 }, // November
      { month: 4, day: 15 }, // May
    ],
    message:
      `📋 **About two weeks until the forms close — worth deciding now what ` +
      `changes.**\n\n` +
      `The **application form** and the **audition form**. Questions still the ` +
      `ones you want to ask, wording still right, anything to add or drop from ` +
      `last time.\n\n` +
      `Nothing to do yet, and better not to: editing a form that's still open ` +
      `changes it under the rows coming in. There's a second reminder on the ` +
      `day they close, which is when the editing is safe.`,
  },
  {
    name: "act",
    days: [
      { month: 11, day: 1 }, // December
      { month: 5, day: 1 }, // June
    ],
    message:
      `📋 **The forms close today — this is the window to change them.**\n\n` +
      `Whatever you settled on a fortnight ago, now's when it goes in: the ` +
      `**application form** and the **audition form**.\n\n` +
      `${COLUMNS}\n\n` +
      `This is the only reminder about it until the next half.`,
  },
];

export async function runFormReview(env: Env, now = new Date()): Promise<FormReviewResult> {
  if (!(await isEnabled(env, "applications"))) return { skipped: "flag_off" };
  return runYearlyReminders(env, "applications:form-review", STAGES, now);
}
