/**
 * Twice a year, asks the directors to change the Round 2 group piece — once to
 * decide what it should be, and once to put it up.
 *
 * **The dates are the halves of the year, and deliberately the same ones.**
 * Jan 1 and Jul 1 are already where membership enforcement lands; a group piece
 * that turned over on some other pair of dates would give the audition two
 * different ideas of which half it was in.
 *
 * **Why this can't be automatic.** Picking the piece is the judgement; all a
 * job can do is pick the moment. And the moment is worth getting right, because
 * `assignToAll` is deliberately conservative about who it touches — it is the
 * same path used to replace a piece that has leaked, where the people to leave
 * alone are exactly the ones who did nothing wrong. Run on the first of the
 * month it reaches the people waiting to start and nobody else, which is what
 * you want. Run halfway through a window it reaches the same set, and the
 * people it skipped are then a half behind with nothing recording why.
 */
import { isEnabled } from "../config/flags";
import { runYearlyReminders, type YearlyResult, type YearlyStage } from "../config/yearly";
import type { Env } from "../env";

export interface PieceReviewResult extends YearlyResult {
  skipped?: "flag_off";
}

const STAGES: readonly YearlyStage[] = [
  {
    name: "think",
    days: [
      { month: 11, day: 15 }, // December
      { month: 5, day: 15 }, // June
    ],
    message:
      `💎 **About two weeks until the next Round 2 group piece goes up.**\n\n` +
      `Worth settling on one now. Round 2 is the piece everyone learns, scored ` +
      `on the four dimensions against the bar — so it wants to be something ` +
      `that can be read on all four, not a showcase for one of them.\n\n` +
      `Nothing to do yet. There's a second reminder on the day to put it up.`,
  },
  {
    name: "act",
    days: [
      { month: 0, day: 1 }, // January
      { month: 6, day: 1 }, // July
    ],
    message:
      `💎 **Time to put the new Round 2 group piece up.**\n\n` +
      `\`/diamonds assign-all round:2 piece:<link>\`\n\n` +
      `It reaches everyone who's through Round 1 and hasn't started Round 2 — ` +
      `and costs them nothing, because Round 2 only reveals the piece when they ` +
      `press start, so the link they're holding is one they've never seen. ` +
      `Anyone mid-window or already submitted keeps the piece they're working ` +
      `on, which is deliberate: their record stores the link they were given, ` +
      `so a swap can't lose track of who danced what.\n\n` +
      `**It doesn't stick for later.** Nothing stores "the current group ` +
      `piece", so anyone who passes Round 1 after today needs ` +
      `\`/diamonds assign\` for their Round 2 the same as before.`,
  },
];

export async function runPieceReview(env: Env, now = new Date()): Promise<PieceReviewResult> {
  if (!(await isEnabled(env, "diamonds"))) return { skipped: "flag_off" };
  return runYearlyReminders(env, "diamonds:piece-review", STAGES, now);
}
