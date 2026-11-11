import type { Env } from "../env";

/**
 * Numeric config. No number governing a contestable decision lives in code
 * (design doc s3), so these read KV and can be changed without a deploy.
 *
 * TODO: back with the Config sheet alongside the flag registry.
 */
export type SettingKey =
  | "application_audition_days"
  | "decision_min_votes"
  | "draft_reping_hours"
  | "waitlist_revisit_days"
  | "invite_days"
  | "backstop_max_per_run"
  | "audition_max_per_run"
  | "audition_days"
  | "audition_lapse_days"
  | "extension_days"
  | "trainee_min_votes"
  | "cycle_prompt_days"
  | "poll_days"
  | "booking_lead_days"
  | "booking_repost_days"
  | "session_reminder_days"
  | "video_reminder_days"
  | "audition_open_days"
  | "audition_close_days"
  | "diamonds_window_days"
  | "diamonds_bar"
  | "diamonds_floor"
  | "diamonds_required_steps"
  | "diamonds_start_nudge_days"
  | "diamonds_start_heads_up_days"
  | "diamonds_review_min_days"
  | "diamonds_review_max_days"
  | "diamonds_min_scores"
  | "diamonds_notice_first"
  | "diamonds_notice_second"
  | "diamonds_notice_final"
  | "diamonds_retry_months";

const DEFAULTS: Record<SettingKey, number> = {
  /** Days a "RISK audition process" card waits for a submission before closing. */
  application_audition_days: 14,
  /** Doc open question 3's suggested default: "minimum 2". */
  decision_min_votes: 2,
  /** "A draft unactioned 48h before the date it references re-pings." */
  draft_reping_hours: 48,
  /** How long a waitlisted applicant sits before resurfacing for another look. */
  waitlist_revisit_days: 30,
  /**
   * Invite lifetime, matching the deadline the acceptance email states. The link
   * expiring IS the deadline, rather than a second thing anyone has to enforce.
   */
  invite_days: 7,
  /**
   * Cards the backstop will post in one run. Each costs a Discord post plus one
   * fetch per video link, against a Worker's fixed subrequest budget — past it
   * every remaining row fails at once. Leftovers wait for the next run.
   */
  backstop_max_per_run: 5,
  /** Same reasoning, for matching audition submissions to their cards. */
  audition_max_per_run: 5,
  /** Rank 12: days a trainee has to submit, counted from the coach's approval. */
  audition_days: 7,
  /**
   * Grace after the deadline before an unsubmitted audition lapses. Shorter
   * than extension_days on purpose — if it weren't, ignoring the deadline
   * would beat asking for more time.
   */
  audition_lapse_days: 3,
  /** What [Grant extension] adds, prefilled and overridable. */
  extension_days: 5,
  /**
   * Directors who must agree to settle a *trainee* audition, out of however
   * many there are. Two rather than all three, because a director who coaches
   * the trainee has no business voting on them — and waiting on a vote that
   * isn't coming would stall every trainee that director works with.
   */
  trainee_min_votes: 2,
  /**
   * How long before the current cycle *ends* to propose the next one. Counted
   * back from the end rather than forward from a stored sequence position, so a
   * cycle that was stretched or cut short still prompts at the right time.
   */
  cycle_prompt_days: 21,
  /** How long the availability poll stays open. */
  poll_days: 7,
  /**
   * How far ahead a room can be booked. The library's window, and the reason
   * the whole job exists — a session that crosses this line unnoticed is a
   * session RISK doesn't get.
   */
  booking_lead_days: 30,
  /** How long to leave a bookable session alone before saying so again. */
  booking_repost_days: 3,
  /** How far ahead of a session to remind people it's happening. */
  session_reminder_days: 2,
  /**
   * And how far ahead to ask for anything wanting feedback. One day, because
   * it's the last point where posting a video still gets it watched before
   * the session rather than after.
   */
  video_reminder_days: 1,
  /**
   * The audition window, counted back from the cycle's end (design doc §12:
   * "proposals open at end − 35, close at end − 14"). Open early enough that a
   * coach can ask for a different song and still leave time to learn it.
   */
  audition_open_days: 35,
  audition_close_days: 14,
  /**
   * Days to learn a piece, record it and submit — the same for both Diamonds
   * rounds. Three, because that's long enough to learn a piece and short
   * enough that what someone does under the pressure is part of what's being
   * looked at.
   */
  diamonds_window_days: 3,
  /**
   * The Diamonds bar: the weighted score Round 2 has to clear
   * (DIAMONDS-RUBRIC.md). Here rather than in code because it is meant to move
   * between cycles — and because Round 2's outcome is derived from it, moving
   * it re-derives everyone who hasn't had a result sent yet, together.
   */
  diamonds_bar: 7.5,
  /**
   * And the floor no single dimension may sit below, whatever the average does.
   * Weighting makes this matter more, not less: 10/10/10 with a zero in
   * musicality still weights to 9.0.
   */
  diamonds_floor: 6,
  /**
   * Anchor steps of improvement Round 1 asks for on the target dimension. One
   * step is 1.25 on the scoring ladder — see `ANCHOR_STEP`.
   */
  diamonds_required_steps: 1,
  /**
   * How far ahead of the *last possible start date* to nudge someone who still
   * hasn't started. Keyed off that rather than the deadline because that's the
   * day the option disappears.
   */
  diamonds_start_nudge_days: 3,
  /**
   * And the earlier, gentler one. Ten rather than seven because the gap between
   * a piece going up and the last day to start is seventeen days: a nudge at
   * ten leaves a week before the warning at three, so the two don't arrive as a
   * pair of warnings.
   */
  diamonds_start_heads_up_days: 10,
  /**
   * The turnaround we promise after a submission, as a range.
   *
   * A range rather than one number because it's a promise two people have to
   * keep by hand, and "within 3 days" read as a guarantee is a promise that
   * gets broken. "1 to 5" is honest about the spread and still useful: the
   * slow end is what the derived Round 0 cutoff is computed from, so nobody is
   * let in on an optimistic estimate and then runs out of time.
   *
   * Rolling rounds move the review load off one date and onto a stream, which
   * is easier to do — but it also makes the wait invisible to the person
   * waiting, which is why it's a number at all.
   */
  diamonds_review_min_days: 1,
  diamonds_review_max_days: 5,
  /**
   * Directors who must score a Diamonds round before it can settle.
   *
   * Two, which with two directors is unanimity — and that's the known sharp
   * edge: a recusal leaves one ballot against a threshold of two and the round
   * never settles. DIAMONDS.md argues the fix is a third voice in
   * `config:director_ids`; until there is one, this is the number to drop to 1
   * for a case where one of you has to sit out. Editable in KV for exactly that
   * reason, and `/diamonds roster` shows who is stuck on one ballot so it can't
   * sit there unnoticed.
   */
  diamonds_min_scores: 2,
  /**
   * The renewal ladder: days before someone's enforcement date that they get
   * told about it. Two months, one month, twenty days.
   *
   * Three rungs rather than one because the thing being asked for takes weeks,
   * not minutes — a re-audition is three rounds and two three-day windows, so a
   * single warning would have to come so early that it reads as noise and so
   * late that it is useless. The spacing narrows on purpose: sixty days is "put
   * it in your calendar", thirty is "pick your week", twenty is "there is just
   * about room left to finish".
   *
   * Twenty is not an arbitrary floor. Three rounds need about sixteen days end
   * to end at the slow end of the review promise, so a notice later than that
   * would be telling someone about a deadline they can no longer meet.
   *
   * Only the most urgent rung reached is ever sent — see `noticeDue` — so
   * tightening these can't produce a burst.
   */
  diamonds_notice_first: 60,
  diamonds_notice_second: 30,
  diamonds_notice_final: 20,
  /**
   * Months someone has to wait after an audition they didn't pass.
   *
   * Months rather than days because it is a season, not a cooling-off period:
   * the point is that whatever was short of the bar takes a stretch of actual
   * training to move, and six months is the gap between two audition windows.
   *
   * It applies to any audition that ended without a pass, at whichever round it
   * ended. Not to someone who withdrew — withdrawing is leaving, not failing,
   * and the record never got far enough to say otherwise.
   *
   * Directors can put someone back on the list inside it with `/diamonds add`,
   * which is the same escape hatch registration-after-close uses. Whether an
   * exception is right is their call to make and not this file's.
   */
  diamonds_retry_months: 6,
};

export async function getNumber(env: Env, key: SettingKey): Promise<number> {
  const raw = await env.KV.get(`config:${key}`);
  if (raw === null) return DEFAULTS[key];
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULTS[key];
}

/**
 * The crew's wall clock, for turning a typed slot into an actual instant.
 *
 * Must match the Apps Script project's timezone, because that is what
 * CalendarApp builds events in — if the two disagree, the calendar invite and
 * the Discord timestamp describe different moments.
 */
export const DEFAULT_TIME_ZONE = "America/New_York";

export async function getTimeZone(env: Env): Promise<string> {
  const raw = (await env.KV.get("config:timezone"))?.trim();
  if (!raw) return DEFAULT_TIME_ZONE;
  try {
    // Validated rather than trusted: an unrecognised zone makes Intl throw, and
    // a typo here would quietly shift every interview by hours.
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    console.error("config:timezone is not a valid IANA zone, using the default:", raw);
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Who else is invited to every interview, alongside the applicant.
 *
 * KV rather than code: the directors change, and their addresses are personal
 * data that has no business in a public repo. Comma- or newline-separated.
 */
export async function getInterviewGuests(env: Env): Promise<string[]> {
  const raw = await env.KV.get("config:interview_guests");
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,\n]/)
        .map((one) => one.trim())
        .filter((one) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(one)),
    ),
  ];
}
