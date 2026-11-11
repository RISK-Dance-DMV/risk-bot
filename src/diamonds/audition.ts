/**
 * Diamonds comp auditions. Pure.
 *
 * Diamonds is the competition unit. `src/config/subunits.ts` deliberately
 * leaves it out of placement — "you can't audition into it directly ... you go
 * through a separate comp audition after" — and this is that audition. It is
 * not a rank in design doc v11; see DIAMONDS.md and DIAMONDS-RUBRIC.md for the
 * process and the bar.
 *
 * Three rounds, one submission each, and **three different kinds of judgment**:
 *
 *   0  a 1-min piece of your own choosing (new auditionees), or registration
 *      and a feedback document (returning Diamonds). Pass or fail — a call the
 *      two directors make, with the reasons written down.
 *   1  a piece assigned to you, chosen to stretch one named weakness. Judged on
 *      movement on that one thing, from a number fixed when the piece went up.
 *   2  one piece everyone learns. Judged on the four dimensions, against the
 *      absolute bar.
 *
 * Nothing carries from one round's judgment to the next. Round 0's verdict is
 * not a score and Round 1's before-number is not Round 0's — see `Ballot` and
 * `fixTarget` for why that separation is the point rather than an oversight.
 *
 * **This mirrors rank 12's clock deliberately rather than importing it.** Rank
 * 12 (`src/trainees/audition.ts`) is the trainee audition loop and its
 * request -> window -> deadline -> remind -> lapse shape is this shape. It is
 * also uncommitted work in flight, so duplicating the shape now and extracting
 * the common clock later is cheaper than refactoring underneath it. Keep the
 * names aligned so that extraction stays mechanical.
 *
 * Two things are NOT shared, and shouldn't be:
 *   - The record. Rank 12 carries `song`/`songLink`/`proposalStatus` because
 *     the *trainee proposes*. Here the piece is assigned, so the direction
 *     reverses and half those fields would be permanently undefined.
 *   - The target set. `isAuditionTarget("Diamonds")` is false and stays false.
 */

/**
 * The four dimensions, in the order the scoring deck presents them.
 *
 * Order is load-bearing wherever the four are read as a list — the card, the
 * ballot, `weightedScore` — so a readout never depends on object key order.
 */
export const DIMENSIONS = [
  "technicality",
  "execution",
  "performance",
  "musicality",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABEL: Record<Dimension, string> = {
  technicality: "Technicality",
  execution: "Execution",
  performance: "Performance",
  musicality: "Musicality & Timing",
};

/** A score per dimension on the 0–10 ladder. */
export type Scores = Record<Dimension, number>;

/** How much each dimension counts toward the final score. */
export type Weights = Record<Dimension, number>;

/**
 * The default weighting.
 *
 * Not equal, and the ordering is a judgement about what a competition unit
 * needs most: technique is the thing that can't be faked or coached quickly,
 * and musicality counts least because it's the most improvable with time in
 * the room.
 *
 * A policy number, so it's a default here and a parameter everywhere — same
 * treatment as the bar. `weightedScore` normalises by the sum, so these can be
 * written as 0.4/0.3/0.2/0.1 or as 4/3/2/1 and mean the same thing.
 */
export const DEFAULT_WEIGHTS: Weights = {
  technicality: 0.4,
  execution: 0.3,
  performance: 0.2,
  musicality: 0.1,
};

/**
 * The ladder's own step size.
 *
 * The scoring deck's anchors sit 1.25 apart (0, 1.25, 2.5 ... 8.75, 10), so one
 * anchor is the natural unit of improvement. A constant rather than a setting
 * because it's a property of the scale, not a policy choice — the policy is how
 * many steps Round 1 requires, which is passed in.
 */
export const ANCHOR_STEP = 1.25;

export type Round = 0 | 1 | 2;
export const ROUNDS: Round[] = [0, 1, 2];

/** Which cohort someone is in. Changes Round 0 and nothing after it. */
export type Cohort = "new" | "returning";

/**
 * A granted extension. Same shape as rank 12's, including that `days` may be
 * fewer than a full window — an extension is sized to whatever went wrong, not
 * handed out as a second attempt.
 */
export interface Extension {
  days: number;
  reason: string;
  by: string;
  at: string;
}

export interface RoundRecord {
  /**
   * The piece they're to learn. Assigned by a director ahead of the round so
   * that retrieval needs nobody present — Round 1 is per-person, Round 2 is the
   * same link for everyone.
   */
  assignedPiece?: string;
  /**
   * When it was put up. Round 1's `startableAt` counts the working gap from
   * here, so it is the piece's timestamp rather than a nicety for the card.
   */
  assignedAt?: string;
  /**
   * When the clock started — and, in a reveal-on-start round, the moment they
   * first saw the piece. One action, because two invited someone to walk away
   * holding the piece and never open a window at all.
   */
  windowOpenedAt?: string;
  extension?: Extension;
  submittedAt?: string;
  submissionUrl?: string;
  /** Set once the deadline DM has gone out, so it goes out once. */
  remindedAt?: string;
  /**
   * Set once the early "your piece is waiting" heads-up has gone out.
   *
   * Separate marker from `startNudgedAt` rather than a counter, because the two
   * messages aren't the same message twice — one is an invitation and one is a
   * warning, and a field per message is the cheapest way to be sure nobody gets
   * the warning without the invitation.
   */
  startHeadsUpAt?: string;
  /** Set once the "last day to start is coming" nudge has gone out, likewise. */
  startNudgedAt?: string;
  /**
   * Roughly when they said they'd start this round, as a plain day.
   *
   * Per round rather than once at registration, because under rolling rounds
   * each round is a separate decision about when to find three days — and
   * because the estimate is only useful while it's recent. One guessed in
   * November about a round they'll reach in December is not a plan, it's a mood.
   *
   * Not binding on anyone, and the bot never refuses anything on the strength
   * of it. What it does is two things: it lets directors see the review stream
   * coming, and it gives the dancer a date of their own choosing to be reminded
   * of — which, for work nobody is scheduling on your behalf, is most of what
   * actually gets it done.
   */
  plannedStartAt?: string;
  /** Set once the "you said today" reminder has gone out, once. */
  plannedRemindedAt?: string;
  /**
   * Set when the result has actually been sent to the dancer.
   *
   * The freeze point. Round 2's outcome is *derived* from the scores and the
   * current bar, so moving the bar re-derives everybody at once and nobody ends
   * up judged against a different number than their cohort. Once a result has
   * gone out that stops being true — you can't unsend it — so a sent result is
   * recorded rather than recomputed.
   */
  resultSentAt?: string;
  /**
   * One per director, keyed by their id. **Sealed:** nobody sees anybody
   * else's until every required ballot is in.
   *
   * The seal matters more with two directors than it would with three. With
   * three, a visible tally nudges the third; with two, the first vote
   * effectively decides the second — there is nowhere to hide and no majority
   * to join. DIAMONDS.md argues this at length and `src/trainees/review.ts`
   * already does it for trainee auditions.
   */
  ballots?: Record<string, Ballot>;
  /**
   * One director's note on this round, keyed by their id. Rounds 1 and 2.
   *
   * Written **before or after** their ballot, whenever suits — rank 12 works
   * this way and the reason carries: the useful moment to write something down
   * is while you're watching, which is not necessarily the moment you've made
   * up your mind.
   *
   * The text stays sealed until the round settles. Same purpose as sealing the
   * ballots — nobody anchored by what was written before them — but tied to
   * settlement rather than to everyone having written, because a director
   * sitting this one out is never going to write, and holding the others' words
   * hostage to that would mean the dancer hears none of it.
   */
  feedback?: Record<string, { text: string; at: string }>;
  scoredAgainst?: { bar: number; floor: number; weights: Weights };
  /** Recorded when the round is settled for this person. */
  outcome?: RoundOutcome;
  outcomeAt?: string;
}

/**
 * How a round ended for one person.
 *
 * `practice` is its own outcome rather than a flavour of failure: the
 * announcement explicitly invites people to keep going after not advancing, so
 * "didn't advance but is still in" has to be representable.
 */
export type RoundOutcome = "advanced" | "practice" | "passed" | "failed";

/** Round 0's ballot: a judgment, not a measurement. */
export type Verdict = "pass" | "fail";

/**
 * One director's reading of one round.
 *
 * Three rounds, three different questions, so three different fields rather
 * than one shape that two of them have to lie about:
 *
 *   0  `verdict`      — is this person worth taking into the process at all?
 *   1  `targetScore`  — where is the one named weakness now?
 *   2  `scores`       — the four dimensions, against the bar.
 *
 * **Round 0 carries no number, and nothing it produces is read later.** It used
 * to set the four-dimension baseline *and* the before-number for Round 1's
 * delta, which meant a verdict on a cover someone picked themselves became the
 * yardstick for a piece they were handed. Those two reads are not comparable,
 * and the gap between them was doing real damage: a flattering Round 0 could
 * cut someone who had genuinely improved. Round 1's before-number is now set
 * deliberately, at assignment — see `fixTarget`.
 */
export interface Ballot {
  verdict?: Verdict;
  scores?: Scores;
  targetScore?: number;
  at: string;
}

/**
 * The written feedback on someone's Round 0, and the thing that opens Round 1.
 *
 * It carries the verdict out with it. Round 0 ends in a pass or a fail, and
 * sending those as two messages would mean someone reads "you're through"
 * before the paragraph explaining what they're through on — or worse, reads the
 * paragraph and has to guess. One message, decision and reasons together, which
 * is also how rank 12 sends a trainee review.
 *
 * One shape for both cohorts. A newcomer's is written against the cover they
 * submitted; a returning Diamond's against their season, since they submit
 * nothing. Either way **delivering it is what opens Round 1**, which is why
 * `activeRound` keys off `deliveredAt` rather than off the submission.
 *
 * The spec's shape: "at least 3 evident strengths that contributed to the team"
 * and "max 3 opportunities to grow in". Both bounds are enforced where the
 * document is written rather than trusted — a document with two strengths isn't
 * the thing that was promised, and nobody notices a missing one later.
 *
 * Delivered as each one is written, which under rolling rounds is the only
 * option: there's no shared date to batch them against, and the person waiting
 * is blocked until theirs arrives.
 */
export interface FeedbackDocument {
  /** The document itself — a link, or the text. */
  content: string;
  /** At least three. */
  strengths: string[];
  /** One to three. */
  growthAreas: string[];
  writtenBy: string;
  submittedAt: string;
  /** Set when it has actually reached the dancer. */
  deliveredAt?: string;
}

export interface DiamondsRecord {
  discordId: string;
  /**
   * When they joined the list. Round 1's gap counts from here.
   *
   * Optional only because a record written before this existed won't have one —
   * `startableAt` falls back to the assignment rather than doing arithmetic on
   * undefined.
   */
  registeredAt?: string;
  /** Captured on first contact — an embed title can't render a mention. */
  displayName?: string;
  cohort: Cohort;
  rounds: Partial<Record<Round, RoundRecord>>;
  /**
   * What Round 1 targets, in words — "elbows collapsing on extensions", "timing
   * drifts late in the second eight".
   *
   * Free text rather than one of the four dimensions, because the four are how
   * you *score* and this is what someone has to go and fix. "Execution" is not
   * a thing anyone can practise; "weak arms" is. The delta is measured on this
   * note, scored on the same 0–10 ladder, which is why it has to be specific
   * enough that two people watching the same video would score it the same way.
   */
  target?: string;
  /** The "before" in Round 1's delta, on the same 0–10 ladder as the after. */
  targetBefore?: number;
  /**
   * When the pair above were fixed, which is **the moment Round 1's piece went
   * up** — they are set by the same act, see `fixTarget`.
   *
   * Fixed rather than editable, and fixed at that moment specifically, because
   * the whole weight of Round 1 rests on the before-number. Set it while the
   * after-video does not yet exist and it can only be an honest read of where
   * someone is; leave it editable afterwards and it drifts toward whatever
   * justifies the outcome, which is not a thing anyone does on purpose.
   */
  targetFixedAt?: string;
  /** Returning Diamonds only. Their Round 0 — they submit nothing. */
  document?: FeedbackDocument;
  withdrawnAt?: string;
}

export function roundOf(record: DiamondsRecord, round: Round): RoundRecord {
  return record.rounds[round] ?? {};
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/* -------------------------------------------------------------------------- */
/* The timeline                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Two timeline, not five.
 *
 * An earlier design ran the rounds as cohort-wide phases: everybody's Round 1
 * opened on one day and closed on another. That was five configured timeline, and
 * it bought nothing — the audition is **pass/fail against a fixed bar**, so
 * nobody is being compared to anybody, and the only thing the phases actually
 * did was make people wait for each other.
 *
 * So: one window, and everyone moves through the three rounds at their own
 * pace. Which round you're in is a fact about your record, not about today's
 * date — see `activeRound`.
 */
export interface DiamondsTimeline {
  /** When registration and Round 0 open. */
  opensAt: string;
  /** The last moment any window, in any round, may close. */
  closesAt: string;
}

/**
 * The last instant a window of `windowDays` may start and still close in time.
 *
 * One number for all three rounds now, because they all end at the same place.
 */
export function lastStartAt(closesAt: string, windowDays: number): string {
  return addDays(closesAt, -windowDays);
}

/**
 * How long three rounds take at worst, from a Round 0 submission.
 *
 * Two reviews and two windows. There is no separate working gap to add any
 * more: Round 1 is gated on the feedback arriving rather than on a countdown,
 * so the only waiting the process imposes is the reviewing, and whatever time
 * someone takes with their feedback is time they chose to take.
 *
 * Uses the slow end of the review range, because this number's job is to decide
 * whether someone still has room — and a cutoff computed from the optimistic
 * case would let people in who then run out of time through nobody's fault.
 */
export function daysStillNeeded(policy: {
  windowDays: number;
  reviewMaxDays: number;
}): number {
  return policy.reviewMaxDays + policy.windowDays + policy.reviewMaxDays + policy.windowDays;
}

/**
 * The last day a Round 0 submission still leaves room for Rounds 1 and 2.
 *
 * Derived, and the honest thing to put in the announcement: there is no Round 0
 * "deadline" any more, there's a point past which three rounds no longer fit.
 */
export function lastRound0At(
  timeline: DiamondsTimeline,
  policy: { windowDays: number; reviewMaxDays: number },
): string {
  return addDays(timeline.closesAt, -daysStillNeeded(policy));
}

export type ActiveRound = { ok: true; round: Round } | Refusal;

/**
 * Which round this person is in right now.
 *
 * Read off their own record rather than the calendar, which is what rolling
 * rounds means: you are in the round after the last one you finished, whenever
 * that happened. Derived rather than stored for the reason rank 12 derives
 * `auditionState` — a stored round number and a set of timestamps that disagree
 * is a bug you find by reading a card that says the wrong thing.
 *
 * Round 0 counts as done when **their feedback has reached them**, for both
 * cohorts. A newcomer has to submit a cover to earn that feedback and a
 * returning Diamond doesn't, but the gate is the same event either way — which
 * is what makes "Round 1 can't start until you've got your feedback" a rule
 * rather than a hope.
 */
export function activeRound(record: DiamondsRecord, now: Date): ActiveRound {
  if (record.withdrawnAt) {
    return { ok: false, reason: "You've withdrawn from this audition." };
  }

  const first = roundOf(record, 1);
  const second = roundOf(record, 2);

  // A round that ended badly ends the audition, whichever round it was.
  for (const round of [1, 0] as Round[]) {
    const outcome = roundOf(record, round).outcome;
    if (outcome === "practice" || outcome === "failed") {
      return {
        ok: false,
        reason: `Your audition finished at Round ${round} — your feedback has been sent.`,
      };
    }
  }

  if (second.submittedAt) {
    return {
      ok: false,
      reason: "You're through everything. Waiting on your result — nothing to do.",
    };
  }
  if (first.submittedAt) return { ok: true, round: 2 };

  return record.document?.deliveredAt
    ? { ok: true, round: 1 }
    : { ok: true, round: 0 };
}

/**
 * Whether Round 1's one prerequisite has been met.
 *
 * **Round 1 cannot start until their feedback has reached them.** That's the
 * rule, rather than a day count. An earlier version held the window back a
 * fixed week from registration, and a countdown turns out to be arbitrary in
 * both directions: it can expire before anyone has told the dancer anything,
 * which is the one state it existed to prevent, and it also holds back someone
 * who got their feedback on day two and is ready to work.
 *
 * Keyed to the feedback because that is the thing Round 1 is a response to. The
 * round asks what someone did about a named weakness; until the weakness has
 * been named *to them*, there is nothing for the round to measure. Whatever
 * working time they then take is the stretch between the feedback arriving and
 * their pressing the button, and that is theirs to spend.
 *
 * Rounds 0 and 2 have no prerequisite beyond a piece being up. Round 0 has
 * nothing to prepare for, and Round 2 is the rubric rather than a delta —
 * there's no named thing to go away and fix.
 */
export function feedbackReady(record: DiamondsRecord, round: Round): Check {
  if (round !== 1) return { ok: true };
  if (record.document?.deliveredAt) return { ok: true };
  return {
    ok: false,
    reason:
      "Your feedback hasn't reached you yet, and Round 1 is a response to it — " +
      "there's nothing to work on until it arrives. Nothing's wrong on your end.",
  };
}


/* -------------------------------------------------------------------------- */

/**
 * When a window closes, extension included.
 *
 * Undefined rather than a guess when it hasn't been opened — a deadline for a
 * window nobody started is the kind of number that ends up on a card.
 */
export function windowClosesAt(
  entry: RoundRecord,
  windowDays: number,
): string | undefined {
  if (!entry.windowOpenedAt) return undefined;
  const base = addDays(entry.windowOpenedAt, windowDays);
  return entry.extension ? addDays(base, entry.extension.days) : base;
}

/**
 * Whether a round's piece is revealed by starting the window, or published to
 * everyone on the day.
 */
export type Reveal = "on-start" | "published";

/**
 * How each round hands its piece over.
 *
 * **Round 2 is on-start even though everyone dances the same piece.** The
 * obvious objection is that it leaks — the first person to start can simply
 * tell the rest. The announcement asks them not to and stops there. The
 * response, if it ever comes to one, is `notYetStarted` plus a reassignment,
 * and that stays unpublished on purpose: spelling out who it would hit is also
 * spelling out who would be safe.
 *
 * Revealing privately earns its keep whether or not anyone leaks. Nobody gets a
 * head start on the choreography by waiting, so the window measures the same
 * task for everyone — three days with the piece, whether they start the first
 * day it's up or the last.
 *
 * Round 0 is "published" because there's nothing to reveal — they pick their
 * own piece.
 */
export const ROUND_REVEAL: Record<Round, Reveal> = {
  0: "published",
  1: "on-start",
  2: "on-start",
};

export type WindowState =
  /** No piece assigned yet — nothing anyone can do but wait on a director. */
  | "unavailable"
  /** Ready to go; they haven't started. */
  | "not-started"
  | "open"
  /** Window ran out with nothing submitted. */
  | "lapsed"
  | "submitted";

export function windowState(
  entry: RoundRecord,
  windowDays: number,
  now: Date,
): WindowState {
  if (entry.submittedAt) return "submitted";
  if (!entry.assignedPiece) return "unavailable";
  if (!entry.windowOpenedAt) return "not-started";

  const closes = windowClosesAt(entry, windowDays);
  if (closes && new Date(closes).getTime() <= now.getTime()) return "lapsed";
  return "open";
}

export type Refusal = { ok: false; reason: string };
export type Allowed = { ok: true };
export type Check = Allowed | Refusal;

/**
 * Whether a piece is assigned at all.
 *
 * Self-serve is the point, so the only refusal is "it isn't up yet", and it says
 * so plainly rather than looking like an error — the fix belongs to a director,
 * and there is nothing the auditionee can do about it.
 */
export function pieceReady(entry: RoundRecord): Check {
  if (!entry.assignedPiece) {
    return {
      ok: false,
      reason:
        "Your piece isn't up yet. Nothing's wrong on your end — try again once " +
        "the directors have posted it.",
    };
  }
  return { ok: true };
}

/**
 * The piece, if this person is allowed to see it yet.
 *
 * Undefined rather than empty string so a caller can't accidentally render a
 * blank link as though a piece existed.
 */
export function visiblePiece(
  entry: RoundRecord,
  reveal: Reveal,
): string | undefined {
  if (!entry.assignedPiece) return undefined;
  if (reveal === "published") return entry.assignedPiece;
  return entry.windowOpenedAt ? entry.assignedPiece : undefined;
}

/**
 * The warning that has to appear before the button is pressed.
 *
 * Here rather than in the handler because it's the same sentence in the
 * announcement, on the button's confirmation, and in `/diamonds status` — and
 * because a reveal-on-start round where someone didn't understand the button is
 * the one failure that can't be undone.
 */
export function startWarning(reveal: Reveal, windowDays: number): string {
  return reveal === "on-start"
    ? `Pressing this shows you your piece **and starts your clock at the same ` +
        `time.** From that moment you have ${windowDays} days to learn it, record ` +
        `it and submit. There's no way to un-press it.`
    : `Pressing this starts your clock. From that moment you have ${windowDays} ` +
        `days to record and submit.`;
}

/**
 * Whether they can start their window right now.
 *
 * Every refusal names the thing they'd need to change, because this command is
 * meant to work at 2am with nobody to ask.
 */
export function canStartWindow(
  record: DiamondsRecord,
  round: Round,
  closesAt: string,
  windowDays: number,
  now: Date,
): Check {
  const entry = roundOf(record, round);
  const state = windowState(entry, windowDays, now);

  if (state === "submitted") {
    return { ok: false, reason: "You've already submitted for this round." };
  }
  if (state === "unavailable") return pieceReady(entry);
  if (state === "open") {
    const closes = windowClosesAt(entry, windowDays);
    return {
      ok: false,
      reason: `Your window is already open — it closes ${closes}. Submit before then.`,
    };
  }
  if (state === "lapsed") {
    return {
      ok: false,
      reason:
        "Your window has already closed. A director can grant an extension — " +
        "ask, and say what happened.",
    };
  }

  const feedback = feedbackReady(record, round);
  if (!feedback.ok) return feedback;

  const last = lastStartAt(closesAt, windowDays);
  if (now.getTime() > new Date(last).getTime()) {
    return {
      ok: false,
      reason:
        `Too late to start a ${windowDays}-day window — auditions close ` +
        `${closesAt} and it wouldn't shut before then.`,
    };
  }
  return { ok: true };
}

export function canSubmit(
  entry: RoundRecord,
  windowDays: number,
  now: Date,
): Check {
  const state = windowState(entry, windowDays, now);
  if (state === "open") return { ok: true };
  if (state === "submitted") {
    return { ok: false, reason: "You've already submitted for this round." };
  }
  if (state === "not-started") {
    return { ok: false, reason: "Start your window first, then submit inside it." };
  }
  if (state === "lapsed") {
    return {
      ok: false,
      reason: "Your window has closed. A director can grant an extension.",
    };
  }
  return pieceReady(entry);
}

/**
 * Round 0 is not a window, so it isn't checked like one.
 *
 * Nobody is assigned anything and nobody starts a clock: the whole week is the
 * window. Reusing `canSubmit` here would refuse everyone for having no piece,
 * which is true and useless — so this checks the only thing that governs Round
 * 0, which is whether the week is over.
 *
 * Replacing an earlier submission is allowed, deliberately. The piece is their
 * own choice and re-recording it costs the process nothing, so the deadline is
 * the only thing anyone has to respect. Rounds 1 and 2 refuse a second
 * submission, because there the recording is the timed part.
 */
export function canSubmitRound0(closesAt: string, now: Date): Check {
  if (now.getTime() > new Date(closesAt).getTime()) {
    return { ok: false, reason: "Auditions have closed." };
  }
  return { ok: true };
}

/**
 * Whether a Round 0 submitted now still leaves room for Rounds 1 and 2.
 *
 * A warning rather than a refusal. Anyone may audition for the feedback alone —
 * the announcement says so — and someone who turns up in January knowing they
 * can't finish is making a choice, not a mistake. What they shouldn't do is
 * find out afterwards.
 */
export function roomForThreeRounds(
  timeline: DiamondsTimeline,
  policy: { windowDays: number; reviewMaxDays: number },
  now: Date,
): boolean {
  return now.getTime() <= new Date(lastRound0At(timeline, policy)).getTime();
}

/** The reminder goes out a day before their own window shuts, once. */
export function needsReminder(
  entry: RoundRecord,
  windowDays: number,
  now: Date,
): boolean {
  if (entry.remindedAt || entry.submittedAt || !entry.windowOpenedAt) return false;
  const closes = windowClosesAt(entry, windowDays);
  if (!closes) return false;
  const left = new Date(closes).getTime() - now.getTime();
  return left > 0 && left <= 24 * 60 * 60 * 1000;
}

/**
 * The last-chance nudge: the cliff is coming and they still haven't started.
 *
 * Absolute, because the cliff is absolute — every window in every round has to
 * shut by the same moment, so there is one last start date and it belongs to
 * everyone. This is the only message keyed to the calendar rather than to the
 * person.
 */
export function needsStartNudge(
  entry: RoundRecord,
  closesAt: string,
  windowDays: number,
  nudgeDays: number,
  now: Date,
): boolean {
  if (entry.windowOpenedAt || entry.submittedAt || entry.startNudgedAt) return false;
  if (!entry.assignedPiece) return false;
  const last = new Date(lastStartAt(closesAt, windowDays)).getTime();
  const left = last - now.getTime();
  return left > 0 && left <= nudgeDays * 24 * 60 * 60 * 1000;
}

/**
 * The earlier, gentler one: your piece has been sitting there for a while.
 *
 * Counted from when their window became *startable*, not from the cliff. Under
 * rolling rounds the cliff can be two months off, so a nudge pegged to it would
 * let someone sit on an assigned piece for seven weeks in silence. "It's been
 * ten days" is a fact about them, which is the only kind of fact worth a DM
 * here.
 *
 * Suppressed when the last-chance nudge is also due, which happens to anyone
 * assigned a piece close to the cliff: two DMs in one morning reads as a system
 * with a bug rather than a team paying attention.
 */
export function needsStartHeadsUp(
  record: DiamondsRecord,
  round: Round,
  closesAt: string,
  windowDays: number,
  headsUpDays: number,
  nudgeDays: number,
  now: Date,
): boolean {
  const entry = roundOf(record, round);
  if (entry.windowOpenedAt || entry.submittedAt || entry.startHeadsUpAt) return false;
  if (!entry.assignedPiece) return false;
  if (needsStartNudge({ ...entry, startNudgedAt: undefined }, closesAt, windowDays, nudgeDays, now)) {
    return false;
  }

  // Counted from the assignment, which is also when the feedback went out —
  // the two are the same sitting, and Round 1's gate is the feedback.
  if (!feedbackReady(record, round).ok || !entry.assignedAt) return false;
  const waiting = now.getTime() - new Date(entry.assignedAt).getTime();
  return waiting >= headsUpDays * 24 * 60 * 60 * 1000;
}

/**
 * Whether a day is a sensible thing to plan this round's start for.
 *
 * Validated rather than taken on trust, because a plan the bot can't honour is
 * worse than no plan: they'd be waiting for a reminder on a day they were never
 * able to start, and the first they'd hear of it is a refusal.
 */
export function canPlanStart(
  record: DiamondsRecord,
  round: Round,
  timeline: DiamondsTimeline,
  policy: { windowDays: number },
  day: string,
  now: Date,
): Check {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, reason: "Give the date as YYYY-MM-DD, like `2026-11-29`." };
  }
  // Noon, so the comparison is about the day rather than about a timezone.
  const at = new Date(`${day}T12:00:00Z`).getTime();
  if (Number.isNaN(at)) return { ok: false, reason: `\`${day}\` isn't a real date.` };

  if (at < now.getTime() - 24 * 60 * 60 * 1000) {
    return { ok: false, reason: "That day has already gone — pick one from today onwards." };
  }

  const last = new Date(lastStartAt(timeline.closesAt, policy.windowDays)).getTime();
  if (at > last + 12 * 60 * 60 * 1000) {
    return {
      ok: false,
      reason:
        `Too late — a ${policy.windowDays}-day window started then wouldn't shut ` +
        `before auditions close. The last day to start anything is ` +
        `${lastStartAt(timeline.closesAt, policy.windowDays).slice(0, 10)}.`,
    };
  }

  // No lower bound beyond today: Round 1's gate is the feedback arriving, not a
  // date, and someone planning ahead of it is making a reasonable guess about
  // when we'll get back to them rather than a mistake.
  return { ok: true };
}

/**
 * Whether today is the day they said they'd start.
 *
 * Due *on* the day rather than from it onwards, the same way rank 7's session
 * reminders work: a job that missed its window should stay quiet rather than
 * say "today's the day" two days late.
 */
export function needsPlanReminder(
  entry: RoundRecord,
  windowDays: number,
  now: Date,
): boolean {
  if (!entry.plannedStartAt || entry.plannedRemindedAt) return false;
  if (entry.windowOpenedAt || entry.submittedAt) return false;
  if (windowState(entry, windowDays, now) === "unavailable") return false;
  return entry.plannedStartAt === now.toISOString().slice(0, 10);
}

/**
 * And the one for someone who registered and then never submitted Round 0.
 *
 * No window to key off and no piece to wait on — just a registration and a
 * closing door. Pegged to the point past which three rounds no longer fit,
 * because that is the moment their plan stops being possible.
 */
export function needsRound0Nudge(
  record: DiamondsRecord,
  timeline: DiamondsTimeline,
  policy: { windowDays: number; reviewMaxDays: number },
  nudgeDays: number,
  now: Date,
): boolean {
  if (record.withdrawnAt) return false;
  if (record.cohort === "returning") return false;
  const zero = roundOf(record, 0);
  if (zero.submittedAt || zero.startNudgedAt) return false;

  const cliff = new Date(lastRound0At(timeline, policy)).getTime();
  const left = cliff - now.getTime();
  return left > 0 && left <= nudgeDays * 24 * 60 * 60 * 1000;
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The flat average. Descriptive only — `weightedScore` is what decides.
 *
 * Kept because "what did they average" is a question people ask, and answering
 * it with a weighted number under the same name would mislead.
 */
export function meanScore(scores: Scores): number {
  return DIMENSIONS.reduce((sum, d) => sum + scores[d], 0) / DIMENSIONS.length;
}

/**
 * The score that decides, weighted per dimension.
 *
 * Normalised by the sum of the weights rather than assuming they total 1, so a
 * weight set that doesn't add up skews nothing — it just expresses the same
 * ratios. A set summing to 0 is meaningless, so it falls back to the flat mean
 * rather than dividing by zero.
 */
export function weightedScore(scores: Scores, weights: Weights): number {
  const total = DIMENSIONS.reduce((sum, d) => sum + weights[d], 0);
  if (total <= 0) return meanScore(scores);
  return DIMENSIONS.reduce((sum, d) => sum + scores[d] * weights[d], 0) / total;
}


/** How many dimensions read as "notable" — the deck's hinge. */
export function notableCount(scores: Scores, bar: number): number {
  return DIMENSIONS.filter((d) => scores[d] >= bar).length;
}

/**
 * The deck's holistic anchor, derived from the four scores rather than judged
 * separately.
 *
 * Its top anchors literally count areas — 8.75 is "notable in multiple areas",
 * 7.5 is "a couple" — so per-dimension scoring produces the overall reading
 * instead of competing with it.
 */
export function overallBand(scores: Scores, bar: number): string {
  const notable = notableCount(scores, bar);
  if (notable >= 3) return "notable ability in multiple areas";
  if (notable === 2) return "notable ability in a couple of areas";
  if (meanScore(scores) >= bar - ANCHOR_STEP) return "evidence of ability on a positive trajectory";
  return "evidence of ability, not notable";
}

/**
 * Round 2's absolute bar: the weighted score clears `bar`, and nothing is below
 * `floor`.
 *
 * **The floor matters more under weighting, not less.** Unweighted, a single
 * weak dimension drags the average toward itself. Weighted, a dimension at 10%
 * barely moves the number — 10/10/10/0 weights to 9.0 and would sail past any
 * bar with a *zero* in musicality. The floor is the only thing standing between
 * that score and a pass, which is the whole reason it exists: in a competition
 * unit a dimension at 5 is visible on stage next to three people who have it.
 */
export function passesFinal(
  scores: Scores,
  bar: number,
  floor: number,
  weights: Weights = DEFAULT_WEIGHTS,
): boolean {
  if (DIMENSIONS.some((d) => scores[d] < floor)) return false;
  return weightedScore(scores, weights) >= bar;
}

/**
 * Round 2's outcome, derived rather than stored.
 *
 * Same reasoning rank 12 gives for deriving `auditionState`: "a stored status
 * and a set of timestamps that disagree is a bug you find by reading a card
 * that says the wrong thing; derived, they can't disagree."
 *
 * It also makes the bar genuinely movable. Change it and every unsent result
 * re-derives together, so a cohort is never split between two standards — which
 * is the thing that actually goes wrong when a number gets adjusted mid-round.
 * Once a result has been sent the stored outcome wins, because it has already
 * been said out loud.
 */
export function round2Outcome(
  scores: Scores | undefined,
  bar: number,
  floor: number,
  weights: Weights = DEFAULT_WEIGHTS,
): RoundOutcome | undefined {
  if (!scores) return undefined;
  return passesFinal(scores, bar, floor, weights) ? "passed" : "failed";
}

export interface Advancement {
  advanced: boolean;
  before: number;
  after: number;
  /** Change on the targeted weakness, in anchor steps. */
  steps: number;
  /** Which branch of the rule carried it, for the card and the feedback. */
  because: "improved" | "already-there" | "no-movement";
}

/* -------------------------------------------------------------------------- */
/* Tallying                                                                    */
/* -------------------------------------------------------------------------- */

export interface Tally {
  count: number;
  /** Whether enough directors have scored for anything to be decided. */
  complete: boolean;
  /** The mean of the four, once every ballot in hand carries them. */
  scores?: Scores;
  /** And the mean on the named weakness, likewise. */
  targetScore?: number;
  /**
   * Round 0's verdict, once every ballot in hand carries one — or `"split"`.
   *
   * Not a majority, because with two directors there is no majority to have:
   * one each is a tie, and the mean trick that works on scores doesn't apply to
   * a decision with two values. So a disagreement reports itself as a
   * disagreement and nothing settles, which is correct — the two of them have a
   * conversation and one of them changes their ballot.
   */
  verdict?: Verdict | "split";
}

const mean = (values: readonly number[]): number =>
  values.reduce((total, one) => total + one, 0) / values.length;

/**
 * What the ballots add up to.
 *
 * The mean rather than a vote, because these are measurements on a shared
 * ladder rather than opinions to be counted — two directors who say 6 and 7
 * are not disagreeing about an outcome, they are bracketing a number. Where
 * they *are* far apart, `ballotSplits` surfaces it rather than this quietly
 * splitting the difference.
 *
 * Incomplete tallies report nothing but a count. That's the seal: a director
 * part-way through scoring a cohort can see how many ballots are in and no
 * more, which is the whole point of nobody's number nudging anybody else's.
 */
export function tally(entry: RoundRecord, minScores: number): Tally {
  const ballots = Object.values(entry.ballots ?? {});
  const complete = ballots.length >= Math.max(1, minScores);
  if (!complete) return { count: ballots.length, complete: false };

  const scored = ballots.filter((one) => one.scores).map((one) => one.scores!);
  const targeted = ballots.filter((one) => one.targetScore !== undefined);
  const verdicts = ballots
    .filter((one) => one.verdict !== undefined)
    .map((one) => one.verdict!);

  return {
    count: ballots.length,
    complete: true,
    // Only when *every* ballot carries them. A mean over a subset would be a
    // different question answered with the same confidence.
    scores:
      scored.length === ballots.length
        ? (Object.fromEntries(
            DIMENSIONS.map((one) => [one, mean(scored.map((set) => set[one]))]),
          ) as Scores)
        : undefined,
    targetScore:
      targeted.length === ballots.length
        ? mean(targeted.map((one) => one.targetScore!))
        : undefined,
    verdict:
      verdicts.length === ballots.length
        ? verdicts.every((one) => one === verdicts[0])
          ? verdicts[0]
          : "split"
        : undefined,
  };
}

export interface Split {
  what: Dimension | "target";
  low: number;
  high: number;
}

/**
 * Where the directors are further apart than one anchor step.
 *
 * Surfaced rather than refused. Two directors have no tiebreak, so a wide split
 * is a conversation to have, not an error state — but it has to be visible,
 * because the mean of 4 and 9 looks exactly like the mean of 6 and 7 and the
 * two mean completely different things.
 *
 * Keyed to `ANCHOR_STEP` rather than a configurable tolerance: one step apart
 * on the scoring ladder is the smallest disagreement the ladder can express, so
 * more than that is the natural line.
 */
export function ballotSplits(entry: RoundRecord, step = ANCHOR_STEP): Split[] {
  const ballots = Object.values(entry.ballots ?? {});
  if (ballots.length < 2) return [];

  const splits: Split[] = [];
  for (const what of DIMENSIONS) {
    const values = ballots.filter((one) => one.scores).map((one) => one.scores![what]);
    if (values.length < 2) continue;
    const low = Math.min(...values);
    const high = Math.max(...values);
    if (high - low > step) splits.push({ what, low, high });
  }

  const targets = ballots
    .filter((one) => one.targetScore !== undefined)
    .map((one) => one.targetScore!);
  if (targets.length >= 2) {
    const low = Math.min(...targets);
    const high = Math.max(...targets);
    if (high - low > step) splits.push({ what: "target", low, high });
  }
  return splits;
}

/**
 * Round 1: improvement on the targeted weakness, not an absolute bar.
 *
 * Advance on either branch — gained at least `requiredSteps` anchors, or was
 * already at the bar and didn't regress. The second branch exists because
 * someone already strong in their weakest dimension has little room to move and
 * shouldn't be cut for it.
 *
 * The reason to measure a delta at all: an absolute bar here would cut whoever
 * started lowest, which is the same people every cycle. A delta cuts whoever
 * didn't move.
 */
export function advancesRound1(
  before: number,
  after: number,
  bar: number,
  requiredSteps: number,
): Advancement {
  const steps = (after - before) / ANCHOR_STEP;

  if (steps >= requiredSteps) {
    return { advanced: true, before, after, steps, because: "improved" };
  }
  if (before >= bar && after >= before) {
    return { advanced: true, before, after, steps, because: "already-there" };
  }
  return { advanced: false, before, after, steps, because: "no-movement" };
}


/* -------------------------------------------------------------------------- */
/* The returning-member document                                              */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                    */
/* -------------------------------------------------------------------------- */

export interface Settled {
  outcome: RoundOutcome;
  /** Round 1 only: the delta that decided it. */
  advancement?: Advancement;
  /** Round 2 only: what the scores were judged against. */
  against?: { bar: number; floor: number; weights: Weights };
}

/**
 * The round that needs scoring next, which is *not* the round they're in.
 *
 * Someone who has submitted Round 1 is in Round 2 as far as `activeRound` is
 * concerned — they're waiting on a piece — while the thing on a director's desk
 * is their Round 1 video. Two different questions, so two functions.
 *
 * Lowest first, so a backlog is worked in the order it arrived rather than in
 * whatever order someone opens cards.
 */
export function roundToScore(
  record: DiamondsRecord,
  minScores: number,
): Round | undefined {
  if (record.withdrawnAt) return undefined;

  // A newcomer has to have sent a cover before Round 0 can be decided; a
  // returning Diamond is judged on their season, so there is nothing to wait
  // for. After that it's like any other round — it needs deciding until its
  // result has gone out.
  const zero = roundOf(record, 0);
  const zeroReady = record.cohort === "returning" || !!zero.submittedAt;
  if (zeroReady && !zero.resultSentAt) return 0;

  for (const round of [1, 2] as Round[]) {
    const entry = roundOf(record, round);
    if (!entry.submittedAt || entry.resultSentAt) continue;
    return round;
  }
  return undefined;
}

/**
 * How a round ended for one person, derived from the ballots and the bar.
 *
 * **Derived, not stored, right up until the result is sent.** The bar is a
 * parameter precisely so it can move between cycles, and while it can still
 * move, moving it has to re-derive everyone at once — otherwise two people in
 * the same cohort get judged against different numbers depending on which
 * evening someone ran a command. Once a result has gone out that stops being
 * true, because you can't unsend it, so a sent result is read back rather than
 * recomputed.
 *
 * Round 0 settles from the two verdicts rather than from a number, and a
 * disagreement doesn't settle at all — there is no tiebreak to apply and no
 * mean to take, so it waits for one of them to move.
 */
export function settleRound(
  record: DiamondsRecord,
  round: Round,
  policy: {
    bar: number;
    floor: number;
    requiredSteps: number;
    minScores: number;
    weights: Weights;
  },
): Settled | undefined {
  const entry = roundOf(record, round);
  if (entry.resultSentAt && entry.outcome) {
    return { outcome: entry.outcome, against: entry.scoredAgainst };
  }
  const counted = tally(entry, policy.minScores);
  if (!counted.complete) return undefined;

  if (round === 0) {
    if (counted.verdict === undefined || counted.verdict === "split") return undefined;
    return { outcome: counted.verdict === "pass" ? "passed" : "failed" };
  }

  if (round === 1) {
    if (record.targetBefore === undefined || counted.targetScore === undefined) {
      return undefined;
    }
    const advancement = advancesRound1(
      record.targetBefore,
      counted.targetScore,
      policy.bar,
      policy.requiredSteps,
    );
    return {
      // Not "failed". The announcement invites people to keep going after not
      // advancing, so "didn't advance but is still in" has to be its own thing.
      outcome: advancement.advanced ? "advanced" : "practice",
      advancement,
    };
  }

  const outcome = round2Outcome(counted.scores, policy.bar, policy.floor, policy.weights);
  if (!outcome) return undefined;
  return {
    outcome,
    against: { bar: policy.bar, floor: policy.floor, weights: policy.weights },
  };
}

/**
 * Whether written feedback can be shown yet.
 *
 * Tied to the round settling rather than to every director having written, for
 * the reason `src/trainees/review.ts` gives: the one who is sitting out never
 * writes, and waiting for them means nobody ever reads anything.
 */
export function feedbackRevealed(
  record: DiamondsRecord,
  round: Round,
  policy: {
    bar: number;
    floor: number;
    requiredSteps: number;
    minScores: number;
    weights: Weights;
  },
): boolean {
  return settleRound(record, round, policy) !== undefined;
}

/** The notes, in roster order, for the dancer's DM. */
export function composeFeedback(
  entry: RoundRecord,
  directorIds: readonly string[],
): string {
  return directorIds
    .map((id) => entry.feedback?.[id]?.text.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/** Who has written something, whether or not it can be read yet. */
export function feedbackWritten(entry: RoundRecord): string[] {
  return Object.entries(entry.feedback ?? {})
    .filter(([, one]) => one.text.trim())
    .map(([id]) => id);
}

/**
 * Whether a returning Diamond's Round 0 document is ready to go out.
 *
 * Two things have to be true, and they can happen in either order: the document
 * has to be written, and Round 0 has to have settled — because the document
 * carries the verdict out with it. Whichever lands second is what sends it.
 *
 * Held rather than refused, which is the point. The useful moment to write this
 * is while you're watching, not after you've both made up your minds, and rank
 * 12 makes the same call for the same reason.
 */
export function documentReady(record: DiamondsRecord, minScores: number): Check {
  if (!record.document) {
    return { ok: false, reason: "Nothing written yet." };
  }
  const counted = tally(roundOf(record, 0), minScores);
  if (!counted.complete || counted.verdict === undefined) {
    return {
      ok: false,
      reason:
        "Written, but held: it goes out with the verdict, and Round 0 isn't " +
        "decided yet. It sends itself the moment both of you have called it.",
    };
  }
  if (counted.verdict === "split") {
    return {
      ok: false,
      reason:
        "Written, but held: one of you has this as a pass and the other as a " +
        "fail. Nothing settles on a split — talk it through and rescore.",
    };
  }
  return { ok: true };
}

/**
 * Whether a ballot has the fields its round needs.
 *
 * Per round rather than one shape for all three, because the rounds genuinely
 * ask different questions: Round 0 decides whether to take someone on, Round 1
 * scores one named weakness, and Round 2 goes back to the four dimensions. A
 * single required shape would make two of the three lie.
 */
export function ballotComplete(round: Round, ballot: Ballot): Check {
  if (round === 0) {
    return ballot.verdict === undefined
      ? {
          ok: false,
          reason:
            "Round 0 is a pass or a fail — does this person belong in the " +
            "process? No numbers here; what you saw goes in the feedback, " +
            "where they can actually use it.",
        }
      : { ok: true };
  }
  if (round === 1) {
    return ballot.targetScore === undefined
      ? {
          ok: false,
          reason:
            "Round 1 needs a score for the one thing you named, on the same 0–10 " +
            "ladder you gave it before. That's the whole round.",
        }
      : { ok: true };
  }
  if (!ballot.scores) {
    return {
      ok: false,
      reason: "Score all four dimensions — technicality, execution, performance, musicality.",
    };
  }
  return { ok: true };
}

export const MIN_STRENGTHS = 3;
export const MAX_GROWTH_AREAS = 3;

export type DocumentInput = {
  content: string;
  strengths: string[];
  growthAreas: string[];
};

export type DocumentResult =
  | { ok: true; strengths: string[]; growthAreas: string[]; content: string }
  | Refusal;

/**
 * Checks a document against the shape the spec promised.
 *
 * The lower bound on growth areas is mine, not the spec's — it caps at three
 * and says nothing about a minimum. A document with none would leave the dancer
 * with praise and no direction, which is the opposite of what Round 0 is for.
 */
export function validateDocument(input: DocumentInput): DocumentResult {
  const strengths = input.strengths.map((one) => one.trim()).filter(Boolean);
  const growthAreas = input.growthAreas.map((one) => one.trim()).filter(Boolean);
  const content = input.content.trim();

  if (!content) {
    return { ok: false, reason: "The document needs a link or some text." };
  }
  if (strengths.length < MIN_STRENGTHS) {
    return {
      ok: false,
      reason:
        `At least ${MIN_STRENGTHS} strengths — you've given ${strengths.length}. ` +
        "The promise was three evident strengths that contributed to the team.",
    };
  }
  if (growthAreas.length === 0) {
    return {
      ok: false,
      reason: "At least one opportunity to grow — otherwise there's no Round 1 target.",
    };
  }
  if (growthAreas.length > MAX_GROWTH_AREAS) {
    return {
      ok: false,
      reason: `At most ${MAX_GROWTH_AREAS} opportunities to grow — you've given ${growthAreas.length}.`,
    };
  }
  return { ok: true, strengths, growthAreas, content };
}

/**
 * Whether a feedback document can still be filed for a returning Diamond.
 *
 * Open for as long as the audition is. Under cohort-wide phases this closed on
 * the day Round 1's pieces went up; rolling, that moment is per person and is
 * enforced where it belongs — a document can't be filed once Round 0's result
 * has gone out, because the result *is* the document.
 *
 * Worth saying plainly because the document *is* a returning Diamond's Round 0:
 * until it has been sent, they have nothing to do and nothing moves.
 */
export function canFileDocument(closesAt: string, now: Date): Check {
  if (now.getTime() > new Date(closesAt).getTime()) {
    return { ok: false, reason: "Auditions have closed." };
  }
  return { ok: true };
}

/**
 * Names Round 1's target and fixes the number it starts from.
 *
 * **Both happen at assignment, by the same hand that picks the piece.** That is
 * the whole design, and it is worth being explicit about why, because an earlier
 * version derived the before-number from Round 0's scores and it was wrong in a
 * way that was hard to see.
 *
 * Round 0 is a cover the dancer chose. Round 1 is a piece they were handed, with
 * three days on it. Scoring "weak arms" at 7 on the first and 5.5 on the second
 * is not a measurement of someone getting worse — it is two different questions
 * with the same units, and the delta between them is noise. Worse, the noise had
 * a direction: pick a flattering cover and you start high, so improving honestly
 * reads as regression and gets you cut. The people best at choosing a cover were
 * the people most at risk from it.
 *
 * So the before-number is now a deliberate read: with the piece in front of you,
 * you say where that one thing sits today. It is still a judgment, but it is a
 * judgment of the same thing Round 1 will score, made by the same people, in the
 * same sitting as the piece they chose to test it with.
 *
 * Fixed at that moment and not editable after. Round 1's whole verdict rests on
 * this number, and the after-video does not exist yet when it is set — which is
 * exactly the property that makes it trustworthy.
 */
export function fixTarget(
  record: DiamondsRecord,
  target: string,
  targetBefore: number,
  at: string,
): { ok: true; record: DiamondsRecord } | Refusal {
  if (record.targetFixedAt) {
    return {
      ok: false,
      reason:
        `Round 1's target was fixed ${record.targetFixedAt} — **${record.target}**, ` +
        `at ${record.targetBefore?.toFixed(1)}/10 — and can't be changed. The ` +
        `before-number is the whole round; moving it now would be moving the ` +
        `goalposts, whichever way it went.`,
    };
  }
  const note = target.trim();
  if (!note) {
    return {
      ok: false,
      reason:
        "Say what Round 1 targets — one specific thing, not a dimension. " +
        "Whatever they'd have to practise to move the number.",
    };
  }
  if (!Number.isFinite(targetBefore) || targetBefore < 0 || targetBefore > 10) {
    return {
      ok: false,
      reason: `Score "${note}" from 0 to 10 — that's the number Round 1 has to move.`,
    };
  }
  return {
    ok: true,
    record: { ...record, targetFixedAt: at, target: note, targetBefore },
  };
}

/**
 * Everyone who hasn't opened their window for a round yet.
 *
 * The operational answer to a leaked Round 2 piece. The announcement's threat —
 * "we'll change the piece for everyone who hasn't started" — is only executable
 * if the people it applies to can be identified, and `assignedPiece` is stored
 * per person per round even when the value is the same for all of them, so
 * swapping it for this set is an update to these records and nothing else.
 *
 * Deliberately **not** everyone: resetting a window that's already running
 * would punish the people who did nothing wrong hardest, and someone who has
 * already submitted can't be asked to do it again.
 */
export function notYetStarted(
  records: readonly DiamondsRecord[],
  round: Round,
): DiamondsRecord[] {
  return records.filter((r) => {
    const entry = roundOf(r, round);
    return !entry.windowOpenedAt && !r.withdrawnAt;
  });
}

/** Documents written but not yet sent. The sweep delivers these. */
export function awaitingDelivery(
  records: readonly DiamondsRecord[],
): DiamondsRecord[] {
  return records.filter((r) => r.document && !r.document.deliveredAt);
}
