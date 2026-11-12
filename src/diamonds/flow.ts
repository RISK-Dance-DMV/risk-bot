/**
 * The Diamonds audition loop (DIAMONDS.md).
 *
 *   dancer    /diamonds register                  joins the list
 *   dancer    /diamonds submit  (Round 0)         their own cover, new cohort only
 *   director  /diamonds assign                    one piece per auditionee
 *   dancer    [Start time now]                    reveals the piece, starts the clock
 *   dancer    /diamonds submit  (Rounds 1, 2)     inside their own window
 *
 * The point of the shape is that the middle column needs nobody present. A
 * dancer at 2am can see where they stand, start their window and submit; the
 * only thing that waits on a director is the piece being there at all, and that
 * happens once for everybody before the round opens.
 *
 * Records live in KV, keyed by person rather than by attempt — a Diamonds
 * audition is one process with three rounds, not three attempts. Nothing here
 * emails, and every word a *dancer* receives is a DM or an ephemeral reply,
 * because a score is nobody else's business. The one thing posted to a channel
 * is the review card, which goes to #audition-review for the directors — the
 * video and what is still owed on it, never a ballot.
 *
 * Scoring, outcomes and results are **not** here. Round 1 results aren't due
 * until DEC 14 and Round 2's not until JAN 16, and the pure core already holds
 * the decisions (`advancesRound1`, `round2Outcome`) for when they are.
 */
import { getDirectorIds } from "../config/directors";
import { isEnabled } from "../config/flags";
import {
  addRole,
  alertDirectors,
  editMessage,
  postToChannelByName,
  memberRoles,
  removeRole,
  sendDirectMessage,
} from "../discord/rest";
import type { MessagePayload } from "../discord/types";
import type { Env } from "../env";
import {
  ROUND_REVEAL,
  canStartWindow,
  canSubmit,
  ballotComplete,
  ballotSplits,
  canPlanStart,
  auditionFinished,
  auditionResulted,
  retryBlocked,
  runDaysLeft,
  runEndsAt,
  runExpired,
  membershipLapsed,
  withLapse,
  composeFeedback,
  enforcementFor,
  noticeDue,
  reAudition,
  documentReady,
  feedbackRevealed,
  feedbackReady,
  feedbackSentOut,
  feedbackUnread,
  needsPlanReminder,
  needsReminder,
  needsRound0Nudge,
  needsStartHeadsUp,
  roundOf,
  roundToScore,
  fixTarget,
  settleRound,
  tally,
  validateDocument,
  windowClosesAt,
  type Cohort,
  type DiamondsTimeline,
  type DiamondsRecord,
  type DocumentInput,
  type Ballot,
  type Round,
  type RoundOutcome,
  type RoundRecord,
  type Scores,
  type Settled,
  type Split,
  type Tally,
  type Verdict,
} from "./audition";
import {
  cycleName,
  feedbackArrived,
  resultMessage,
  reviewCard,
  roundPanel,
  type PanelContext,
  type ReviewOptions,
} from "./card";
import {
  getDiamondDirectorRoleId,
  getDiamondsRoleId,
  getDiamondsTimeline,
  getDiamondsPolicy,
  type DiamondsPolicy,
} from "./config";

const RECORD_PREFIX = "dia:rec:";
/**
 * Long enough to outlive a membership term, with room to spare.
 *
 * Was 400 days, which was right when a record was one two-month cycle. It is
 * wrong now: an enforcement date can be fifteen months out (`enforcementFor`),
 * so a 400-day record would expire *before* the date written on it — taking the
 * membership, the renewal notices and the audition history with it, silently,
 * about six weeks early. 600 covers the longest term plus the notice ladder.
 */
const RECORD_TTL = 600 * 24 * 60 * 60;

const recordKey = (discordId: string) => `${RECORD_PREFIX}${discordId}`;

export type FlowResult =
  | { ok: true; record: DiamondsRecord; warning?: string }
  | { ok: false; reason: string };

export async function getRecord(
  env: Env,
  discordId: string,
): Promise<DiamondsRecord | null> {
  return env.KV.get<DiamondsRecord>(recordKey(discordId), "json");
}

export async function putRecord(env: Env, record: DiamondsRecord): Promise<void> {
  await env.KV.put(recordKey(record.discordId), JSON.stringify(record), {
    expirationTtl: RECORD_TTL,
  });
}

/**
 * Everyone on the list.
 *
 * A listing rather than a maintained index: the index is the thing that goes
 * stale, and a Diamonds cohort is tens of people, not thousands.
 */
export async function allRecords(env: Env): Promise<DiamondsRecord[]> {
  const records: DiamondsRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: RECORD_PREFIX, cursor });
    for (const key of page.keys) {
      const record = await env.KV.get<DiamondsRecord>(key.name, "json");
      if (record) records.push(record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records.sort((a, b) =>
    (a.displayName ?? a.discordId).localeCompare(b.displayName ?? b.discordId),
  );
}

/** Writes one round's fields without disturbing the others. */
function withRound(
  record: DiamondsRecord,
  round: Round,
  patch: Partial<RoundRecord>,
): DiamondsRecord {
  return {
    ...record,
    rounds: { ...record.rounds, [round]: { ...roundOf(record, round), ...patch } },
  };
}

/* -------------------------------------------------------------------------- */
/* Joining                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Registering is idempotent, and refuses only once Round 0 has closed.
 *
 * Someone running it twice is asking "am I on the list?", and the honest answer
 * is yes — an error would read as having been thrown off it. The second run
 * refreshes the display name and leaves every round alone.
 *
 * Nothing is asked about eligibility. Whether a Major cover or a Diamonds
 * project has been done decides whether a *pass* can place someone, which is a
 * question at the end rather than the start — and asking it here would collect
 * a self-reported answer that no decision is ever going to be made on.
 *
 * What it does ask is roughly when they plan to go, which lands on Round 0 —
 * later rounds get their own estimate when the piece is in front of them. Not
 * binding on anybody. Re-registering updates it, and leaving it off keeps
 * whatever was there.
 *
 * The closed-window refusal is the one case worth refusing: joining in December
 * would mean skipping the round everyone else did, and the person who can make
 * that call is a director, not the command.
 */
export async function register(
  env: Env,
  discordId: string,
  displayName: string,
  cohort: Cohort,
  plannedStartAt: string | undefined,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
  /**
   * Practice from the start, if that's what they asked for.
   *
   * Asked at registration rather than offered later, because it changes what
   * every round of theirs is for: a practice Round 0 has no verdict to wait on,
   * and the whole run carries no consequence. Choosing it at the door is also
   * the only point at which it's clearly a choice rather than a reaction to a
   * score they didn't like.
   */
  practice = false,
): Promise<FlowResult> {
  const existing = await getRecord(env, discordId);

  // The wait after an audition that didn't pass. Checked before the archive,
  // because the archive is what would hide the audition it's counted from.
  const blocked = existing && retryBlocked(existing, policy.retryMonths, now);
  if (blocked) {
    const unix = Math.floor(new Date(blocked).getTime() / 1000);
    return {
      ok: false,
      reason:
        `There's a **${policy.retryMonths}-month wait** after an audition that ` +
        `didn't go through, so you can register again from <t:${unix}:D> ` +
        `(<t:${unix}:R>).\n` +
        `It isn't a punishment — it's that the things we'd have told you to work ` +
        `on take a stretch of real training to move, and coming back in a month ` +
        `would show us the same audition. If something about your case is ` +
        `different, ask a director: they can put you on the list anyway.`,
    };
  }

  // Registering again is how you start again. One door rather than a second
  // command, because "put my name down for this audition" is the same sentence
  // the second time — and because a dancer who has finished and wants another
  // go will look for the thing they used the first time.
  //
  // Only when the last audition is *finished*. Someone who withdrew mid-process
  // and came back is picking up where they left off, which is what this did
  // before and still does: the rounds survive and only `withdrawnAt` is cleared.
  const resumed = existing && auditionFinished(existing)
    ? reAudition(existing, now.toISOString())
    : undefined;
  if (resumed && !resumed.ok) return { ok: false, reason: resumed.reason };

  const base: DiamondsRecord = resumed
    ? { ...resumed.record, displayName }
    : existing
      ? { ...existing, displayName, withdrawnAt: undefined }
      : { discordId, displayName, cohort, registeredAt: now.toISOString(), rounds: {} };

  // Only ever set here, and only on: a registration that doesn't ask for
  // practice leaves an existing choice alone rather than silently undoing it,
  // because `/diamonds register` is also the "am I still on the list?" command
  // and running it twice shouldn't change what someone signed up for.
  if (practice) base.practiceFrom = 0;

  // The estimate given at registration is Round 0's. Later rounds get their own
  // through `/diamonds plan`, when the piece is actually in front of them.
  const record = plannedStartAt
    ? withRound(base, 0, { plannedStartAt })
    : base;
  await putRecord(env, record);
  return { ok: true, record };
}

/**
 * A director putting someone on the list, deadline or wait or neither.
 *
 * The companion to registration refusing late, and to it refusing inside the
 * retry wait. Refusing was right — the command shouldn't decide whether someone
 * may skip the round everyone else did, or whether their case is the exception
 * — but a refusal that points at a director and then gives the director no way
 * to act is just a dead end with better manners.
 *
 * So this checks neither. Both refusals exist to route a judgement to the two
 * people entitled to make it, and this is where they make it.
 *
 * DMs them the panel, because being added without being told is the same as not
 * being added.
 */
export async function addEntry(
  env: Env,
  discordId: string,
  cohort: Cohort,
  round: Round,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  const existing = await getRecord(env, discordId);
  // Same reset as `register` for an audition that ran its course, so adding a
  // finished member by hand doesn't drop them into last cycle's completed
  // rounds. Not for a withdrawal: the likeliest reason to override one is that
  // it was a mistake, so this restores the audition rather than replacing it.
  // The cohort the director picked wins over the one the reset derived.
  const restarted = existing && auditionResulted(existing)
    ? reAudition(existing, now.toISOString())
    : undefined;
  const carried = restarted?.ok ? restarted.record : existing;

  const record: DiamondsRecord = carried
    ? { ...carried, cohort, withdrawnAt: undefined }
    : { discordId, cohort, registeredAt: now.toISOString(), rounds: {} };
  await putRecord(env, record);

  const reached = await tell(env, record, round, timeline, policy, now);
  return {
    ok: true,
    record,
    warning: reached ? undefined : `Added, but couldn't DM <@${discordId}>.`,
  };
}

export async function withdraw(env: Env, discordId: string): Promise<FlowResult> {
  const record = await getRecord(env, discordId);
  if (!record) return { ok: false, reason: "You're not registered for this audition." };
  const updated = { ...record, withdrawnAt: new Date().toISOString() };
  await putRecord(env, updated);
  return { ok: true, record: updated };
}

/**
 * Their own estimate of when they'll start this round.
 *
 * Changeable as often as they like, and nothing is ever refused on the strength
 * of it — what it buys is a reminder on a day they picked themselves, which for
 * work nobody else is scheduling is most of what gets it done.
 */
export async function planStart(
  env: Env,
  discordId: string,
  round: Round,
  day: string,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  const record = await getRecord(env, discordId);
  if (!record) return { ok: false, reason: "You're not registered for this audition." };

  const allowed = canPlanStart(record, round, day.trim(), now);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  // Clears the reminder marker, so moving the date moves the reminder with it
  // rather than silently costing them one.
  const updated = withRound(record, round, {
    plannedStartAt: day.trim(),
    plannedRemindedAt: undefined,
  });
  await putRecord(env, updated);
  return { ok: true, record: updated };
}

/* -------------------------------------------------------------------------- */
/* The window                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Starts the clock and hands over the piece, in one write.
 *
 * One action rather than two on purpose: a separate "fetch" would let someone
 * walk away holding the choreography with no window open, which is the one way
 * to get more than three days with it.
 */
export async function startWindow(
  env: Env,
  discordId: string,
  round: Round,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  const record = await getRecord(env, discordId);
  if (!record) return { ok: false, reason: "You're not registered for this audition." };

  const expired = runOut(record, policy, now);
  if (expired) return expired;

  const allowed = canStartWindow(record, round, policy.windowDays, now);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  const updated = withRound(record, round, { windowOpenedAt: now.toISOString() });
  await putRecord(env, updated);
  return { ok: true, record: updated };
}

/**
 * A submission. Round 0 and the timed rounds are different enough to check
 * differently — see `canSubmitRound0`.
 */
export async function submit(
  env: Env,
  discordId: string,
  round: Round,
  url: string,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  const link = url.trim();
  if (!/^https?:\/\/\S+$/i.test(link)) {
    return { ok: false, reason: "That doesn't look like a link. Paste the full URL." };
  }

  const record = await getRecord(env, discordId);
  if (!record) return { ok: false, reason: "You're not registered for this audition." };

  if (round === 0 && record.cohort === "returning") {
    return {
      ok: false,
      reason:
        "Round 0 asks nothing of returning Diamonds — there's nothing to submit. " +
        "Your feedback document is on its way.",
    };
  }

  const expired = runOut(record, policy, now);
  if (expired) return expired;

  const entry = roundOf(record, round);
  // Round 0 has no window of its own — a cover is a thing you send when you
  // have one — so the only clock on it is the two months for the whole run.
  const allowed = round === 0 ? { ok: true as const } : canSubmit(entry, policy.windowDays, now);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  const updated = withRound(record, round, {
    submissionUrl: link,
    submittedAt: now.toISOString(),
  });

  // Written before the card is posted, and written again if the post gives us
  // ids to keep. Two writes rather than one because the order matters: a
  // submission that survives a Discord outage and loses its card is a bad
  // morning, and a card whose submission was never stored is a lost audition.
  await putRecord(env, updated);
  const carded = await postReviewCard(env, updated, round, policy);
  if (carded !== updated) await putRecord(env, carded);
  return { ok: true, record: carded };
}

/**
 * Records a membership nobody auditioned for.
 *
 * The grandfathering tool, and the only way a membership exists without a pass
 * behind it. Needed because the roster predates the bot: there are Diamonds on
 * the team whose audition happened in a room, and until someone writes their
 * date down, nothing renews and nothing enforces — they are simply invisible to
 * all of this.
 *
 * A date can be given, or derived from today the same way a pass derives one.
 * Given, because grandfathering is exactly the case where the derived answer is
 * wrong: "these two don't have to audition this cycle" is a decision about a
 * specific date, not about today.
 *
 * It refuses to overwrite a date somebody earned, because the two mistakes it
 * could make are not symmetrical: declining to shorten a membership costs a
 * conversation, and silently shortening one costs somebody their place.
 */
export async function grantMembership(
  env: Env,
  discordId: string,
  displayName: string | undefined,
  until: string | undefined,
  now: Date,
): Promise<FlowResult> {
  const at = now.toISOString();
  const enforcedAt = until ?? enforcementFor(at);
  if (Number.isNaN(new Date(enforcedAt).getTime())) {
    return { ok: false, reason: "That date didn't parse. Give it as YYYY-MM-DD." };
  }
  if (new Date(enforcedAt).getTime() <= now.getTime()) {
    return {
      ok: false,
      reason:
        "That date has already passed, so it would be a membership the sweep " +
        "revokes tomorrow morning. Pick one in the future.",
    };
  }

  const existing = await getRecord(env, discordId);
  if (existing?.memberSince && !until) {
    return {
      ok: false,
      reason:
        `<@${discordId}> is already a member until ` +
        `${existing.enforcedAt?.slice(0, 10) ?? "an unrecorded date"}. Pass ` +
        `\`until\` if you mean to change it — I won't move a date somebody ` +
        `earned by guessing at it.`,
    };
  }

  const record: DiamondsRecord = {
    ...(existing ?? { discordId, cohort: "returning" as const, rounds: {} }),
    displayName: displayName ?? existing?.displayName,
    memberSince: existing?.memberSince ?? at,
    enforcedAt,
    // A new date is a new ladder, exactly as on a pass.
    renewalNoticedAt: undefined,
    lapsedAt: undefined,
  };
  await putRecord(env, record);

  const unix = Math.floor(new Date(enforcedAt).getTime() / 1000);
  const reached = await sendDirectMessage(env, discordId, {
    content:
      `💎 **Your Diamonds membership is on the books until <t:${unix}:D>.**\n\n` +
      `Diamonds is re-auditioned rather than permanent — re-audition before then ` +
      `and it renews, and going early in the half is worth a longer next term. ` +
      `You'll get reminders well ahead of the date; there's nothing to do now.`,
  });

  return {
    ok: true,
    record,
    warning: reached ? undefined : `Recorded, but couldn't DM <@${discordId}>.`,
  };
}

/* -------------------------------------------------------------------------- */
/* The review card                                                             */
/* -------------------------------------------------------------------------- */

function reviewOptions(env: Env, policy: DiamondsPolicy): ReviewOptions {
  return {
    minScores: policy.minScores,
    weights: policy.weights,
    bar: policy.bar,
    floor: policy.floor,
    commandChannel: env.CH_DIAMONDS_BOT,
  };
}

function renderReview(
  env: Env,
  record: DiamondsRecord,
  round: Round,
  policy: DiamondsPolicy,
): MessagePayload {
  return reviewCard(
    record,
    round,
    tally(roundOf(record, round), policy.minScores),
    settleRound(record, round, policy),
    reviewOptions(env, policy),
  );
}

/**
 * Puts a submitted video in front of the directors, in the channel they already
 * review in.
 *
 * In the **community** guild, alongside the applicant and trainee videos, which
 * is where `src/trainees/auditionFlow.ts` sends its own. One stack of videos to
 * work through beats three channels to remember.
 *
 * A failure here is not allowed to cost the submission. The record is already
 * written by the time this runs, so the worst case degrades to how the process
 * worked before the card existed — the submission counts, and the directors
 * hear about it through `alertDirectors` instead.
 */
async function postReviewCard(
  env: Env,
  record: DiamondsRecord,
  round: Round,
  policy: DiamondsPolicy,
): Promise<DiamondsRecord> {
  const entry = roundOf(record, round);
  // Resubmission inside an open window replaces the video, not the card.
  if (entry.reviewMessageId) {
    await refreshReviewCard(env, record, round, policy);
    return record;
  }

  try {
    const posted = await postToChannelByName(
      env,
      env.GUILD_COMMUNITY_ID,
      env.CH_AUDITION_REVIEW,
      renderReview(env, record, round, policy),
    );
    return withRound(record, round, {
      reviewMessageId: posted.id,
      reviewChannelId: posted.channelId,
    });
  } catch (err) {
    console.error("diamonds review card", err);
    await alertDirectors(
      env,
      `⚠️ <@${record.discordId}> submitted Round ${round}, and the review card ` +
        `couldn't be posted to #${env.CH_AUDITION_REVIEW}. **The submission is ` +
        `recorded** — score it from \`/diamonds roster\`.\n` +
        (entry.submissionUrl ?? ""),
    );
    return record;
  }
}

/**
 * Brings an existing card up to date, or quietly does nothing.
 *
 * Swallows its own failure on purpose: this runs after a ballot or a sent
 * result has already been written, and throwing here would report a scoring
 * command as failed when the only thing that went wrong was the decoration.
 * The record is the truth and `/diamonds roster` reads it directly.
 */
async function refreshReviewCard(
  env: Env,
  record: DiamondsRecord,
  round: Round,
  policy: DiamondsPolicy,
): Promise<void> {
  const entry = roundOf(record, round);
  if (!entry.reviewMessageId || !entry.reviewChannelId) return;
  try {
    await editMessage(
      env,
      entry.reviewChannelId,
      entry.reviewMessageId,
      renderReview(env, record, round, policy),
    );
  } catch (err) {
    console.error("diamonds review card refresh", err);
  }
}

/* -------------------------------------------------------------------------- */
/* The director's side                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Puts a piece up for one person, and tells them it's there.
 *
 * The DM is the whole reason assignment is a command rather than a spreadsheet
 * edit: self-serve only works if the dancer knows the moment there's something
 * to serve themselves.
 */
export async function assignPiece(
  env: Env,
  discordId: string,
  round: Round,
  piece: string,
  target: { note: string | undefined; before: number | undefined },
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  const link = piece.trim();
  if (!link) return { ok: false, reason: "Give me the piece — a link, or the song." };

  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }

  // The ordering the whole rule rests on: feedback first, then the piece. Round
  // 1 is a response to the feedback, so a piece assigned before it is a piece
  // nobody can start.
  // Keyed to the document having *gone out*, not to their having opened it. A
  // director shouldn't be held up by a dancer's inbox, and the piece is only
  // revealed on start anyway — so it can sit there waiting for them.
  const ready = feedbackSentOut(record, round);
  if (!ready.ok) {
    return {
      ok: false,
      reason:
        `<@${discordId}> hasn't had their feedback yet, and that's what opens ` +
        `Round 1. Send it with \`/diamonds feedback\` first — then the piece.`,
    };
  }

  const entry = roundOf(record, round);
  if (entry.windowOpenedAt) {
    return {
      ok: false,
      reason:
        `<@${discordId}> has already started Round ${round} and seen their piece. ` +
        `Changing it now would reset work they've already done — grant an ` +
        `extension instead, or ask them first.`,
    };
  }

  // Round 1's piece and its before-number are one act. Picking a piece *is*
  // deciding what you're testing, so this is the sitting in which you say what
  // that thing is and where it sits today — and the only sitting in which
  // saying it is safe, because the video that will be compared to it doesn't
  // exist yet. See `fixTarget`.
  let withTarget = record;
  if (round === 1) {
    const note = target.note?.trim();
    if (!note || target.before === undefined) {
      return {
        ok: false,
        reason:
          `Round 1's piece goes up with the thing it's testing and the number ` +
          `that thing starts at. Give both: \`target\` — one specific thing, ` +
          `"elbows collapse on extensions", not "execution" — and ` +
          `\`starting-score\`, 0–10, where you'd put it today. That number is ` +
          `the whole round, and it can't be set later.`,
      };
    }
    const fixed = fixTarget(record, note, target.before, now.toISOString());
    if (!fixed.ok) return { ok: false, reason: fixed.reason };
    withTarget = fixed.record;
  }

  const updated = withRound(withTarget, round, {
    assignedPiece: link,
    assignedAt: now.toISOString(),
  });
  await putRecord(env, updated);

  const reached = await tell(env, updated, round, timeline, policy, now);
  return {
    ok: true,
    record: updated,
    warning: reached ? undefined : `Couldn't DM <@${discordId}> — their DMs are closed.`,
  };
}

/** Everything the panels need, assembled once from the two config reads. */
export function panelContext(
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
): PanelContext {
  return {
    timeline,
    windowDays: policy.windowDays,
    reviewMinDays: policy.reviewMinDays,
    reviewMaxDays: policy.reviewMaxDays,
    minScores: policy.minScores,
    retryMonths: policy.retryMonths,
    bar: policy.bar,
    requiredSteps: policy.requiredSteps,
    runDays: policy.runDays,
  };
}

/** The panel, as a DM, so "your piece is up" arrives with the button on it. */
async function tell(
  env: Env,
  record: DiamondsRecord,
  round: Round,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
): Promise<boolean> {
  const panel = roundPanel(record, round, panelContext(timeline, policy), now);
  return sendDirectMessage(env, record.discordId, panel);
}

/**
 * Round 2's single piece, to everyone who hasn't started.
 *
 * Skips anyone mid-window or already submitted rather than refusing the whole
 * call: this is also the reassignment path if the piece ever gets out, and in
 * that case the people to leave alone are exactly the ones who did nothing
 * wrong.
 */
export async function assignToAll(
  env: Env,
  round: Round,
  piece: string,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
): Promise<{
  assigned: string[];
  skipped: string[];
  unreachable: string[];
  refused?: string;
}> {
  const link = piece.trim();
  const assigned: string[] = [];
  const skipped: string[] = [];
  const unreachable: string[] = [];

  // Round 2 only, and not by accident. One piece to everyone is exactly what
  // Round 2 is; Round 1 hands each person a piece chosen for *their* named
  // weakness, and its before-number is per person too — there is nothing here
  // to fill either in with. Round 0 has no assigned piece at all.
  if (round !== 2) {
    return {
      assigned,
      skipped,
      unreachable,
      refused:
        round === 1
          ? "Round 1 is one piece per person, picked for the one thing it's " +
            "testing, and it goes up with that person's starting number. Use " +
            "`/diamonds assign` — there's no all-at-once version of a choice " +
            "that's different for everybody."
          : "Round 0 is their own piece. There's nothing to assign.",
    };
  }

  for (const record of await allRecords(env)) {
    if (record.withdrawnAt) continue;
    const entry = roundOf(record, round);
    if (entry.windowOpenedAt || entry.submittedAt) {
      skipped.push(record.discordId);
      continue;
    }
    if (roundOf(record, 1).outcome !== "advanced") {
      skipped.push(record.discordId);
      continue;
    }
    const updated = withRound(record, round, {
      assignedPiece: link,
      assignedAt: now.toISOString(),
    });
    await putRecord(env, updated);
    assigned.push(record.discordId);
    if (!(await tell(env, updated, round, timeline, policy, now))) {
      unreachable.push(record.discordId);
    }
  }
  return { assigned, skipped, unreachable };
}

/**
 * Days added to the whole two-month run, rather than to one round's window.
 *
 * The same command as a window extension because it is the same act — a
 * director deciding somebody's circumstances warrant more time — and the two
 * reasons people need it are indistinguishable from the outside: an injury
 * eats a window *and* the run it sits in.
 *
 * **Works after the date has passed, and reopens the audition.** That is the
 * whole point of having it: the refusal a dancer sees when the clock runs out
 * says "talk to a director", and a director with no way to act on that would
 * make the refusal a dead end with better manners. Clearing `expiredAt` puts
 * them back exactly where they were, mid-round, rather than starting them over.
 */
export async function extendRun(
  env: Env,
  discordId: string,
  days: number,
  reason: string,
  by: string,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  if (!Number.isFinite(days) || days <= 0) {
    return { ok: false, reason: "Days has to be a positive number." };
  }
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }
  if (!record.registeredAt) {
    return {
      ok: false,
      reason:
        `<@${discordId}>'s record predates the ${policy.runDays}-day clock, so they ` +
        `don't have one to extend. Nothing is going to run out on them.`,
    };
  }
  // A finished audition has no clock left to move. Said as two refusals because
  // the two situations need different things from a director: a withdrawal or a
  // verdict wants `/diamonds add`, and an expiry is what this is for.
  if (auditionResulted(record) || record.withdrawnAt) {
    return {
      ok: false,
      reason:
        `<@${discordId}>'s audition is already over — ` +
        `${record.withdrawnAt ? "they withdrew" : "the result has gone out"}. ` +
        `More days won't restart it; \`/diamonds add\` will.`,
    };
  }

  const extended: DiamondsRecord = {
    ...record,
    runExtensions: [
      ...(record.runExtensions ?? []),
      { days, reason, by, at: now.toISOString() },
    ],
    // Both cleared deliberately. `expiredAt` is what reopens a closed audition;
    // `runWarnedAt` is so the ten-day warning can fire again against the new
    // date, because an extension that silently costs them their warning is
    // worse than no extension.
    expiredAt: undefined,
    runWarnedAt: undefined,
  };

  const ends = runEndsAt(extended, policy.runDays)!;
  if (new Date(ends).getTime() <= now.getTime()) {
    return {
      ok: false,
      reason:
        `${days} day${days === 1 ? "" : "s"} still leaves them past the date — it ` +
        `would be <t:${Math.floor(new Date(ends).getTime() / 1000)}:D>. Give them ` +
        `enough to actually finish in.`,
    };
  }

  await putRecord(env, extended);

  const unix = Math.floor(new Date(ends).getTime() / 1000);
  const reopened = !!record.expiredAt;
  const reached = await sendDirectMessage(env, discordId, {
    content: reopened
      ? `⏳ **Your audition is open again** — you have until <t:${unix}:D> ` +
        `(<t:${unix}:R>). ${days} extra day${days === 1 ? "" : "s"}, and you pick up ` +
        `exactly where you left off.`
      : `⏳ **You've got ${days} more day${days === 1 ? "" : "s"}** — all three rounds ` +
        `by <t:${unix}:D> (<t:${unix}:R>) now.`,
  });
  return {
    ok: true,
    record: extended,
    warning: reached ? undefined : `Couldn't DM <@${discordId}>.`,
  };
}

export async function grantExtension(
  env: Env,
  discordId: string,
  round: Round,
  days: number,
  reason: string,
  by: string,
  policy: DiamondsPolicy,
): Promise<FlowResult> {
  if (!Number.isFinite(days) || days <= 0) {
    return { ok: false, reason: "Days has to be a positive number." };
  }
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }

  const entry = roundOf(record, round);
  if (!entry.windowOpenedAt) {
    return {
      ok: false,
      reason:
        `<@${discordId}> hasn't started Round ${round}, so there's no window to ` +
        `extend. If they're out of time to start one, assign and let them start late.`,
    };
  }
  if (entry.submittedAt) {
    return { ok: false, reason: `<@${discordId}> has already submitted Round ${round}.` };
  }

  const updated = withRound(record, round, {
    extension: { days, reason, by, at: new Date().toISOString() },
    // The deadline reminder has to be able to fire again against the new close
    // time — otherwise an extension silently costs them their reminder.
    remindedAt: undefined,
  });
  await putRecord(env, updated);

  const closes = windowClosesAt(roundOf(updated, round), policy.windowDays)!;
  const unix = Math.floor(new Date(closes).getTime() / 1000);
  const reached = await sendDirectMessage(env, discordId, {
    content:
      `⏳ **Extension granted** — Round ${round} now closes <t:${unix}:D> ` +
      `(<t:${unix}:R>). ${days} extra day${days === 1 ? "" : "s"}.`,
  });
  return {
    ok: true,
    record: updated,
    warning: reached ? undefined : `Couldn't DM <@${discordId}>.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Feedback documents                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Write someone's Round 0 feedback, and it goes out at once.
 *
 * **Both cohorts.** A newcomer's is written against the cover they submitted, a
 * returning Diamond's against their season — one path, because delivering it is
 * what opens Round 1 and a second path would be a second way for that to not
 * happen.
 *
 * Filing and delivering are one action for the same reason. A queue of
 * filed-but-unsent feedback is a queue of people blocked without knowing it,
 * and under rolling rounds there's no batch day to flush it on.
 */
export async function fileFeedback(
  env: Env,
  discordId: string,
  input: DocumentInput,
  by: string,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }

  // A newcomer has to have shown us something. A returning Diamond hasn't, and
  // that asymmetry is the whole of what the cohort flag is for.
  if (record.cohort === "new" && !roundOf(record, 0).submittedAt) {
    return {
      ok: false,
      reason:
        `<@${discordId}> hasn't submitted a Round 0 cover yet, so there's nothing ` +
        `to write feedback against. Returning Diamonds skip that step; newcomers ` +
        `don't.`,
    };
  }

  const checked = validateDocument(input);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const at = now.toISOString();
  const written: DiamondsRecord = {
    ...record,
    document: {
      content: checked.content,
      strengths: checked.strengths,
      growthAreas: checked.growthAreas,
      writtenBy: by,
      submittedAt: at,
    },
  };

  // Held rather than refused when Round 0 hasn't been decided. The useful
  // moment to write this is while you're watching, which is not necessarily
  // after you've both called it — so it waits, and `scoreRound` sends it the
  // moment the second verdict lands.
  const ready = documentReady(written, policy.minScores);
  if (!ready.ok) {
    await putRecord(env, written);
    // The card says whether the document exists, so it changes here too — a
    // held document is the state a director most needs to see from across the
    // channel.
    await refreshReviewCard(env, written, 0, policy);
    return { ok: true, record: written, warning: ready.reason };
  }

  const delivered = await deliverDocument(env, written, policy, at);
  await putRecord(env, delivered.record);
  await refreshReviewCard(env, delivered.record, 0, policy);
  return {
    ok: true,
    record: delivered.record,
    warning: delivered.reached
      ? undefined
      : `Written, but couldn't DM <@${discordId}> — saved as undelivered, so Round 1 ` +
        `has **not** opened for them. Fix their DMs and file it again.`,
  };
}

/**
 * Sends the notice that a document exists, and marks it delivered.
 *
 * This is also how Round 0's result is sent, which is why it writes
 * `resultSentAt` and the outcome: the verdict goes out with the notice, so
 * nobody has to click to find out whether they're through. What the click is
 * for is the document, and **the click is what opens Round 1** — see
 * `FeedbackDocument.readAt`.
 *
 * Nothing is recorded unless the DM actually arrived. A verdict nobody received
 * hasn't been delivered, and marking Round 0 done on a failed send would strand
 * someone with a decision they were never told.
 */
async function deliverDocument(
  env: Env,
  record: DiamondsRecord,
  policy: DiamondsPolicy,
  at: string,
): Promise<{ record: DiamondsRecord; reached: boolean }> {
  const doc = record.document!;
  const settled = settleRound(record, 0, policy);
  const reached = await sendDirectMessage(
    env,
    record.discordId,
    feedbackArrived(settled?.outcome === "passed", policy.windowDays),
  );
  if (!reached) return { record, reached };
  return {
    record: withRound(
      { ...record, document: { ...doc, deliveredAt: at } },
      0,
      { resultSentAt: at, outcome: settled?.outcome, outcomeAt: at },
    ),
    reached: true,
  };
}

/**
 * Round 0's one message: the verdict, and everything behind it.
 *
 * The decision comes last rather than first. A pass or a fail at the top turns
 * the three paragraphs under it into either a formality or a consolation, and
 * neither is what they are — the feedback is the part that's worth something in
 * both directions, and it's the only part a dancer who didn't get through can
 * still use.
 */
export function feedbackMessage(
  content: string,
  strengths: readonly string[],
  growthAreas: readonly string[],
  passed: boolean,
  policy: DiamondsPolicy,
): MessagePayload {
  const list = (items: readonly string[]) => items.map((one) => `· ${one}`).join("\n");
  return {
    content:
      `**Your Diamonds feedback**\n\n${content}\n\n` +
      `**What you brought**\n${list(strengths)}\n\n` +
      `**Where to grow**\n${list(growthAreas)}\n\n` +
      (passed
        ? `**You're through to Round 1.** We'll send you a piece picked to test ` +
          `one specific thing, and we'll tell you what that thing is and where ` +
          `we have it today. You'll get ${policy.windowDays} days with the piece ` +
          `to show movement on it — everything else still counts, but that one ` +
          `thing is what the round turns on.\n\n` +
          `Start it yourself whenever you're ready: the clock doesn't run until ` +
          `you press the button, so take as long as you like getting there.`
        : `**We're not taking this one through to Round 1.** That's our call on ` +
          `what we saw here, not a verdict on you as a dancer — and everything ` +
          `above is honest and worth having either way. Come back at us next ` +
          `cycle; we'd like you to.`),
  };
}

/**
 * The two-month refusal, shared by starting and submitting.
 *
 * Says the date and points at a director, because by the time anyone reads this
 * the only thing that can help is somebody with the power to add days — and
 * they would much rather do that than have this be the end of it.
 */
function runOut(
  record: DiamondsRecord,
  policy: DiamondsPolicy,
  now: Date,
): { ok: false; reason: string } | undefined {
  if (!runExpired(record, policy.runDays, now)) return undefined;
  const ends = runEndsAt(record, policy.runDays)!;
  const unix = Math.floor(new Date(ends).getTime() / 1000);
  return {
    ok: false,
    reason:
      `Your ${policy.runDays} days ran out on <t:${unix}:D>, so this audition is ` +
      `closed. **Talk to a director** — they can add days or put you back on the ` +
      `list, and they'd rather do that than lose you to a calendar.`,
  };
}

/**
 * Carrying someone into Round 2 as practice after a Round 1 fail.
 *
 * Writes the flag and nothing else — the result still goes out through
 * `sendResult`, so the two of them read the exact words before anything
 * reaches the dancer. Separate from sending on purpose: this changes what
 * Round 2 *is*, and that's a decision worth its own click.
 */
export async function carryAsPractice(
  env: Env,
  discordId: string,
  policy: DiamondsPolicy,
): Promise<FlowResult> {
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }
  if (record.practiceFrom !== undefined) {
    return { ok: false, reason: `<@${discordId}>'s audition is already practice.` };
  }

  const settled = settleRound(record, 1, policy);
  if (settled?.outcome !== "failed") {
    return {
      ok: false,
      reason:
        `This is for a Round 1 that didn't move. <@${discordId}>'s Round 1 ` +
        `${settled ? `settled as **${settled.outcome}**` : "isn't settled yet"}, ` +
        `so there's nothing to carry them out of.`,
    };
  }
  if (roundOf(record, 1).resultSentAt) {
    return {
      ok: false,
      reason:
        `<@${discordId}> has already been told. Changing it now would be two ` +
        `different endings to the same round — tell them yourself, and a ` +
        `director can put them back on the list.`,
    };
  }

  const carried: DiamondsRecord = { ...record, practiceFrom: 2 };
  await putRecord(env, carried);
  await refreshReviewCard(env, carried, 1, policy);
  return { ok: true, record: carried };
}

/**
 * Whether this person is one of the two who judge Diamonds, and so exempt from
 * the renewal ladder.
 *
 * Read off the Discord role rather than the director list, because they are
 * different sets: the director list runs rank 7's cycles and rank 12's
 * auditions as well, and a director who doesn't judge Diamonds owes their
 * renewal like everybody else.
 *
 * No role configured means nobody is exempt, and an unreadable member means not
 * exempt either — a notice someone can ignore is a smaller failure than a
 * membership that silently stops being enforced.
 */
async function judgesDiamonds(
  env: Env,
  roleId: string | null,
  discordId: string,
): Promise<boolean> {
  if (!roleId) return false;
  const roles = await memberRoles(env, env.GUILD_DANCE_ID, discordId);
  return !!roles?.includes(roleId);
}

/**
 * A dancer opening their Round 0 feedback, which is what opens Round 1.
 *
 * Idempotent on purpose. Re-reading is a thing people do — the document is the
 * only record of what they were asked to work on, and they will come back to it
 * mid-window — so a second press shows it again and leaves `readAt` where it
 * was. The first read is the one the round turns on.
 */
export async function markFeedbackRead(
  env: Env,
  discordId: string,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult & { payload?: MessagePayload }> {
  const record = await getRecord(env, discordId);
  const doc = record?.document;
  if (!record || !doc?.deliveredAt) {
    return {
      ok: false,
      reason:
        "There's no feedback of yours to open yet. If you think there should be, " +
        "say so in #diamonds-bot — that's worth a director looking at.",
    };
  }

  const settled = settleRound(record, 0, policy);
  const payload = feedbackMessage(
    doc.content,
    doc.strengths,
    doc.growthAreas,
    settled?.outcome === "passed",
    policy,
  );

  if (doc.readAt) return { ok: true, record, payload };

  const read: DiamondsRecord = {
    ...record,
    document: { ...doc, readAt: now.toISOString() },
  };
  await putRecord(env, read);
  return { ok: true, record: read, payload };
}

/* -------------------------------------------------------------------------- */
/* The daily sweep                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Five messages, each once, all DMs.
 *
 *   window closing   T−1 of their own close time, whoever's window is open
 *   last chance      three days before the one shared cliff
 *   their own date   the day they said they'd start this round
 *   heads-up         ten days sitting on a piece they haven't started
 *   no Round 0 yet   registered, never submitted, and the room is running out
 *
 * The last two are the ones that matter. The closing reminder keys off a window
 * being open, so it cannot reach the person who never opened one — and that
 * person is the likeliest to lose the round to nothing but a calendar.
 *
 * Only one goes out per person per round per run. The checks are mutually
 * exclusive by construction — the reminder needs an open window and the other
 * two need no window — but the ordering is written out anyway, because a sweep
 * that can send two things to one person in one morning is a sweep nobody
 * trusts the third time.
 */
export async function runDiamondsSweep(
  env: Env,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now = new Date(),
): Promise<{
  reminded: number;
  nudged: number;
  headsUp: number;
  round0: number;
  planned: number;
  /** Delivered feedback nobody has opened, nudged once. */
  unread: number;
  /** Runs with the two-month clock nearly up, warned once. */
  warned: number;
  /** Runs that closed with the rounds unfinished. */
  expired: number;
  renewals: number;
  lapsed: number;
  /** Memberships that have run out but could not be revoked, and why. */
  blocked: number;
}> {
  let reminded = 0;
  let nudged = 0;
  let headsUp = 0;
  let round0 = 0;
  let planned = 0;
  let unread = 0;
  let warned = 0;
  let expired = 0;
  let renewals = 0;
  let lapsed = 0;
  let blocked = 0;

  // Read once rather than per record, and `null` is a real answer: with no role
  // configured there is nothing to take off anybody, so the lapse pass counts
  // what it would have done and changes nothing.
  const roleId = await getDiamondsRoleId(env);

  // Who judges Diamonds, and so owes no renewal. Read once; the per-member
  // check below only runs for people who actually have a date.
  const judgeRole = await getDiamondDirectorRoleId(env);

  for (const record of await allRecords(env)) {
    // Withdrawing takes you off the audition, not out of Diamonds. So the round
    // reminders stop and the renewal notice does not — a member who dropped a
    // re-audition is the single person most likely to reach their enforcement
    // date, and silence is what would take them there.
    const quiet = !!record.withdrawnAt;

    // Carried forward rather than re-read: writing the second round from the
    // unpatched record would quietly drop the first round's marker and send its
    // reminder again tomorrow.
    let current = record;
    let spoke = false;

    for (const round of [1, 2] as Round[]) {
      if (spoke || quiet) break;
      const entry = roundOf(current, round);

      if (needsReminder(entry, policy.windowDays, now)) {
        const closes = windowClosesAt(entry, policy.windowDays)!;
        const unix = Math.floor(new Date(closes).getTime() / 1000);
        await sendDirectMessage(env, current.discordId, {
          content:
            `⏰ **Round ${round} closes <t:${unix}:R>.** Submit with ` +
            `\`/diamonds submit link:<url>\` before then. If something's gone ` +
            `wrong, say so now rather than after — a director can add days.`,
        });
        current = withRound(current, round, { remindedAt: now.toISOString() });
        await putRecord(env, current);
        reminded += 1;
        spoke = true;
        continue;
      }

      if (needsPlanReminder(entry, policy.windowDays, now)) {
        await sendDirectMessage(env, current.discordId, {
          content:
            `📌 **You said you'd start Round ${round} today.**\n\n` +
            `No obligation — it was always an estimate, nothing happens if you ` +
            `move it, and \`/diamonds plan\` will set a new day. But you picked ` +
            `this one, and sticking to a day you chose yourself is most of what ` +
            `gets this done when nobody else is scheduling it for you.\n\n` +
            `\`/diamonds start\` when you're ready — ${policy.windowDays} days ` +
            `from the moment you press it.`,
        });
        current = withRound(current, round, { plannedRemindedAt: now.toISOString() });
        await putRecord(env, current);
        planned += 1;
        spoke = true;
        continue;
      }

      if (needsStartHeadsUp(current, round, policy.headsUpDays, now)) {
        await sendDirectMessage(env, current.discordId, {
          content:
            `👋 **Round ${round}: your piece has been waiting ${policy.headsUpDays} ` +
            `days.** No rush, and nothing expires — the ${policy.windowDays} days ` +
            `run from whenever you start.\n` +
            `\`/diamonds start\` when you want it.` +
            (ROUND_REVEAL[round] === "on-start"
              ? `\n\nWorth knowing: starting is what shows you the piece, so ` +
                `there's nothing to look at beforehand and nothing to gain by ` +
                `waiting — everyone gets the same ${policy.windowDays} days with it.`
              : ""),
        });
        current = withRound(current, round, { startHeadsUpAt: now.toISOString() });
        await putRecord(env, current);
        headsUp += 1;
        spoke = true;
      }
    }

    // And the one nobody else can reach: registered, never submitted Round 0,
    // no window to key off and no piece to wait on.
    if (!spoke && !quiet && needsRound0Nudge(current, policy.headsUpDays, now)) {
      await sendDirectMessage(env, current.discordId, {
        content:
          `👋 **You registered ${policy.headsUpDays} days ago and haven't sent ` +
          `your Round 0 cover yet.** There's no deadline on it — nothing closes, ` +
          `and nobody is waiting on anybody else.\n` +
          `An existing cover from the last six months is fine — ` +
          `\`/diamonds submit link:<url>\`.`,
      });
      current = withRound(current, 0, { startNudgedAt: now.toISOString() });
      await putRecord(env, current);
      round0 += 1;
      spoke = true;
    }

    // Feedback delivered and never opened, which is the one way to get stuck
    // that needs nobody's cooperation. Once, then it's theirs: a document is a
    // thing you read when you're ready to read it, and a bot that asks twice is
    // a bot telling someone how to feel about their own feedback.
    if (!spoke && !quiet && feedbackUnread(current, policy.nudgeDays, now)) {
      await sendDirectMessage(env, current.discordId, {
        content:
          `📄 **Your Round 0 feedback is still unopened.** No rush from us, and ` +
          `nothing expires — but **Round 1 doesn't open until you've read it**, ` +
          `so it's the one thing standing between you and your next piece.\n` +
          `It's the message above this one.`,
      });
      current = {
        ...current,
        document: { ...current.document!, readNudgedAt: now.toISOString() },
      };
      await putRecord(env, current);
      unread += 1;
      spoke = true;
    }

    // The two-month clock. Two passes: a warning while there's still time to do
    // something, then the close itself.
    //
    // The warning sits under `spoke` like the other messages, but the close does
    // not — it isn't a message, it's the audition ending, and someone whose run
    // closed this morning should not be told about their open window instead.
    if (!spoke && !quiet && !current.expiredAt) {
      const left = runDaysLeft(current, policy.runDays, now);
      if (
        left !== undefined &&
        left > 0 &&
        left <= policy.headsUpDays &&
        !current.runWarnedAt &&
        !auditionFinished(current)
      ) {
        const ends = Math.floor(new Date(runEndsAt(current, policy.runDays)!).getTime() / 1000);
        await sendDirectMessage(env, current.discordId, {
          content:
            `⏳ **${left} days left on your audition.** All three rounds have to be ` +
            `done by <t:${ends}:D> — that's the ${policy.runDays} days from when you ` +
            `registered.\n` +
            `There's still room: a round takes ${policy.windowDays} days and we turn ` +
            `feedback round in ${policy.reviewMinDays}–${policy.reviewMaxDays}. If you ` +
            `need longer, ask a director now rather than after — they can add days.`,
        });
        current = { ...current, runWarnedAt: now.toISOString() };
        await putRecord(env, current);
        warned += 1;
        spoke = true;
      }
    }

    if (runExpired(current, policy.runDays, now)) {
      current = { ...current, expiredAt: now.toISOString() };
      await putRecord(env, current);
      expired += 1;

      const told = await sendDirectMessage(env, current.discordId, {
        content:
          `⌛ **Your audition has closed.** The ${policy.runDays} days you had to ` +
          `get through all three rounds are up.\n\n` +
          `This isn't a judgement on your dancing — it's a clock, and it exists so ` +
          `a Round 1 read and a Round 2 months later aren't being compared as if ` +
          `they were the same week. **If something got in the way, tell a ` +
          `director:** they can put you straight back on the list, and that's much ` +
          `easier than it sounds.`,
      });
      await alertDirectors(
        env,
        `⌛ **<@${current.discordId}>'s audition has closed** — ${policy.runDays} days ` +
          `up with the rounds unfinished.` +
          (told ? "" : ` ⚠️ Couldn't DM them, so they've not been told.`) +
          `\n\`/diamonds add\` puts them back on if you want to.`,
      );
      continue;
    }

    // Membership running out, which is the one thing in this sweep that changes
    // something outside the bot.
    //
    // Ahead of the notices and outside the `spoke` rule, because it isn't a
    // message — it's a fact, and someone whose membership ran out this morning
    // should not be told about their open window instead.
    if (membershipLapsed(current, now) && !(await judgesDiamonds(env, judgeRole, current.discordId))) {
      if (!roleId) {
        // Fail closed. Marking somebody as revoked while the role stayed on is
        // the one failure here nobody would ever notice.
        blocked += 1;
      } else {
        try {
          await removeRole(env, env.GUILD_DANCE_ID, current.discordId, roleId);
        } catch (err) {
          console.error("diamonds lapse", err);
          blocked += 1;
          continue;
        }

        // Read before `withLapse` clears it. The message names the date the
        // membership ran to, which may be weeks back if it passed while they
        // were mid-audition — and `withLapse` is what makes it unreadable.
        const ranTo = Math.floor(new Date(current.enforcedAt!).getTime() / 1000);

        current = withLapse(current, now.toISOString());
        await putRecord(env, current);
        lapsed += 1;

        // The DM is *after* the role comes off and cannot stop it. A membership
        // that could only end if the person were reachable would make closed
        // DMs a way to stay a Diamond for ever.
        const told = await sendDirectMessage(env, current.discordId, {
          content:
            `💎 **Your Diamonds membership has ended.** It ran to ` +
            `<t:${ranTo}:D>, and a ` +
            `re-audition is what renews it — so the role has come off.\n\n` +
            `This isn't a judgement on your dancing and it isn't a door closing: ` +
            `register again whenever you want and you go through the rounds like ` +
            `anyone else. If you think this is wrong, or something got in the way, ` +
            `tell a director — they can put it right.`,
        });

        await alertDirectors(
          env,
          `💎 **<@${current.discordId}> has come off Diamonds** — their membership ` +
            `ran out today with no re-audition.` +
            (told ? "" : ` ⚠️ Couldn't DM them, so they've not been told.`),
        );
        continue;
      }
    }

    // Membership, which is the one message here that isn't about a round.
    //
    // Last, and behind `spoke`, because everything above means they are already
    // mid-audition: a person who is being reminded to submit does not also need
    // telling that failing to re-audition will remove them.
    if (!spoke) {
      const due = noticeDue(current, policy.noticeDays, now);
      if (due && !(await judgesDiamonds(env, judgeRole, current.discordId))) {
        await sendDirectMessage(
          env,
          current.discordId,
          renewalNotice(
            current.enforcedAt!,
            due.daysLeft,
            policy,
            retryBlocked(current, policy.retryMonths, now),
          ),
        );
        current = {
          ...current,
          // Every rung this one answers for, not just the one sent — so the
          // staler, gentler notices can never arrive after the urgent one.
          renewalNoticedAt: {
            ...(current.renewalNoticedAt ?? {}),
            ...Object.fromEntries(due.covers.map((rung) => [String(rung), now.toISOString()])),
          },
        };
        await putRecord(env, current);
        renewals += 1;
      }
    }
  }

  return {
    reminded,
    nudged,
    headsUp,
    round0,
    planned,
    unread,
    warned,
    expired,
    renewals,
    lapsed,
    blocked,
  };
}

/**
 * The renewal notice, which narrows as the date gets closer.
 *
 * Never says "you will be removed" at sixty days. The first rung is a diary
 * entry, the second is a request to pick a week, and only the last one — the
 * rung set at roughly the length of the audition itself — says what happens if
 * nothing does. A removal warning repeated three times is a removal warning
 * nobody reads.
 */
function renewalNotice(
  enforcedAt: string,
  daysLeft: number,
  policy: DiamondsPolicy,
  blockedUntil: string | undefined,
): MessagePayload {
  const unix = Math.floor(new Date(enforcedAt).getTime() / 1000);
  const date = `<t:${unix}:D>`;

  // Telling someone to re-audition when they can't is worse than saying nothing.
  // This is the member who dropped a re-audition: the wait is running, their
  // date is coming, and the only thing that can help is a director.
  if (blockedUntil && new Date(blockedUntil).getTime() > new Date(enforcedAt).getTime()) {
    const until = Math.floor(new Date(blockedUntil).getTime() / 1000);
    return {
      content:
        `⚠️ **Your Diamonds membership runs to ${date}, and you can't re-audition ` +
        `before <t:${until}:D>.**\n\n` +
        `That's the wait after dropping out, and it runs past your renewal — so ` +
        `on current rules the role comes off on ${date}. **Talk to a director.** ` +
        `They can put you back on the list inside the wait, and they would rather ` +
        `do that than lose you to a calendar.`,
    };
  }
  const needed = policy.reviewMaxDays + policy.windowDays + policy.reviewMaxDays + policy.windowDays;
  const final = policy.noticeDays[0] ?? 0;

  if (daysLeft > (policy.noticeDays[1] ?? 30)) {
    return {
      content:
        `💎 **Your Diamonds membership runs to ${date}** — about two months off.\n` +
        `Re-auditioning before then renews it, and going early is worth more: ` +
        `your next date is set by the half of the year you re-audition in, so the ` +
        `sooner you go the longer the next term. Nothing to do today beyond ` +
        `knowing the date.`,
    };
  }

  if (daysLeft > final) {
    return {
      content:
        `💎 **A month to ${date}**, when your Diamonds membership is up for ` +
        `renewal.\n` +
        `A re-audition needs about ${needed} days end to end — the rounds, the ` +
        `windows and our turnaround — so this is the point to pick the week ` +
        `you'll start rather than the day. \`/diamonds status\` has where you ` +
        `stand.`,
    };
  }

  return {
    content:
      `⚠️ **${daysLeft} days to ${date}.** That's about as long as a re-audition ` +
      `takes, so if you want to renew this term it needs to start now.\n\n` +
      `If you haven't re-auditioned by ${date} you come off the Diamonds role — ` +
      `not a judgement, just how membership works, and you're welcome back at the ` +
      `next audition. If something's in the way, tell a director rather than ` +
      `letting the date pass: they can move it.`,
  };
}

/**
 * The daily job's entry point.
 *
 * Reads the flag here rather than at the endpoint so that turning Diamonds off
 * stops the DMs too — a reminder about an audition that has been called off is
 * worse than no reminder.
 */
export async function runDiamondsDaily(
  env: Env,
): Promise<
  | {
      reminded: number;
      nudged: number;
      headsUp: number;
      round0: number;
      planned: number;
      unread: number;
      warned: number;
      expired: number;
      renewals: number;
      lapsed: number;
      blocked: number;
    }
  | { skipped: "flag off" }
> {
  if (!(await isEnabled(env, "diamonds"))) return { skipped: "flag off" };
  const [timeline, policy] = await Promise.all([
    getDiamondsTimeline(env),
    getDiamondsPolicy(env),
  ]);
  return runDiamondsSweep(env, timeline, policy, new Date());
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

export interface ScoreInput {
  /** Round 0: pass or fail, and nothing else. */
  verdict?: Verdict;
  /** Round 1: where the one named thing sits now. */
  targetScore?: number;
  /** Round 2: the four dimensions. */
  scores?: Scores;
}

export type ScoreResult =
  | {
      ok: true;
      record: DiamondsRecord;
      round: Round;
      tally: Tally;
      splits: Split[];
      settled?: Settled;
      warning?: string;
    }
  | { ok: false; reason: string };

/**
 * One director's ballot on whichever round is waiting to be scored.
 *
 * Sealed: the reply says how many ballots are in and nothing else until the
 * last one lands. With two directors the first number would otherwise decide
 * the second, which is the argument in DIAMONDS.md and the reason
 * `src/trainees/review.ts` does the same.
 *
 * Rescoring is allowed — a ballot is overwritten, not accumulated — so the
 * conversation that follows a wide split can actually change something. What
 * can't change is a sealed baseline or a sent result.
 */
export async function scoreRound(
  env: Env,
  discordId: string,
  by: string,
  input: ScoreInput,
  policy: DiamondsPolicy,
  now: Date,
): Promise<ScoreResult> {
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }

  const round = roundToScore(record, policy.minScores);
  if (round === undefined) {
    return {
      ok: false,
      reason:
        `Nothing of <@${discordId}>'s is waiting to be scored. Either they haven't ` +
        `submitted yet, or every round they have submitted already has its result.`,
    };
  }

  const ballot: Ballot = {
    verdict: input.verdict,
    scores: input.scores,
    targetScore: input.targetScore,
    at: now.toISOString(),
  };
  const shaped = ballotComplete(round, ballot);
  if (!shaped.ok) return { ok: false, reason: shaped.reason };

  if (roundOf(record, round).resultSentAt) {
    return {
      ok: false,
      reason: `Round ${round}'s result has already gone to <@${discordId}>. It can't be unsent.`,
    };
  }

  const withBallot: DiamondsRecord = withRound(record, round, {
    ballots: { ...(roundOf(record, round).ballots ?? {}), [by]: ballot },
  });

  const counted = tally(roundOf(withBallot, round), policy.minScores);
  const splits = ballotSplits(roundOf(withBallot, round));

  // Round 0's result is its feedback document — one message, verdict and
  // reasons together — so settling it and sending it are the same event, and
  // it goes the moment the second verdict lands. The other half of the pair:
  // a document written before either of you had decided has been waiting for
  // exactly this.
  let updated = withBallot;
  let warning: string | undefined;
  if (round === 0 && !updated.rounds[0]?.resultSentAt) {
    const ready = documentReady(updated, policy.minScores);
    if (ready.ok) {
      const delivered = await deliverDocument(env, updated, policy, now.toISOString());
      updated = delivered.record;
      if (!delivered.reached) {
        warning =
          `Round 0 is decided, but couldn't DM <@${discordId}> — so nothing has ` +
          `been said to them and Round 1 has **not** opened. Fix their DMs and ` +
          `file the feedback again.`;
      }
    } else if (counted.complete) {
      warning = ready.reason;
    }
  }

  await putRecord(env, updated);
  await refreshReviewCard(env, updated, round, policy);
  return {
    ok: true,
    record: updated,
    round,
    tally: counted,
    splits,
    settled: settleRound(updated, round, policy),
    warning,
  };
}

/**
 * One director's note on a round, written whenever suits them.
 *
 * Overwrites rather than appends — it's their note, not a thread — and never
 * refuses on timing. The text stays sealed until the round settles, so writing
 * early costs nothing and tells nobody anything.
 */
export async function noteRound(
  env: Env,
  discordId: string,
  by: string,
  text: string,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult & { round?: Round; sealed?: boolean }> {
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }

  const round = roundToScore(record, policy.minScores);
  if (round === undefined) {
    return {
      ok: false,
      reason: `Nothing of <@${discordId}>'s is open for feedback right now.`,
    };
  }
  if (round === 0) {
    return {
      ok: false,
      reason:
        "Round 0's feedback is the written document — `/diamonds feedback` opens " +
        "that form instead.",
    };
  }

  const note = text.trim();
  if (!note) return { ok: false, reason: "Nothing written." };

  const entry = roundOf(record, round);
  const updated = withRound(record, round, {
    feedback: { ...(entry.feedback ?? {}), [by]: { text: note, at: now.toISOString() } },
  });
  await putRecord(env, updated);

  return {
    ok: true,
    record: updated,
    round,
    sealed: !feedbackRevealed(updated, round, policy),
  };
}

/**
 * Sends the result, and freezes it.
 *
 * The one irreversible step in the process, which is why it's a separate action
 * from scoring and why the director reads the message back first. Recording
 * `scoredAgainst` here rather than at scoring time is the same idea from the
 * other direction: up to this moment the outcome re-derives from the current
 * bar, so moving the bar moves everyone together; after it, the number they
 * were told is the number that stands.
 */
export async function sendResult(
  env: Env,
  discordId: string,
  directorIds: readonly string[],
  ctx: PanelContext,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult & { round?: Round; outcome?: RoundOutcome }> {
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }

  const round = roundToScore(record, policy.minScores);
  if (round === undefined || round === 0) {
    return {
      ok: false,
      reason:
        round === 0
          ? `Round 0 sends itself. Its result **is** their feedback document — ` +
            `one message, verdict and reasons together — so it goes the moment ` +
            `it's written and you've both called it. Write it with ` +
            `\`/diamonds feedback\`.`
          : `Nothing of <@${discordId}>'s is waiting on a result.`,
    };
  }

  const settled = settleRound(record, round, policy);
  const counted = tally(roundOf(record, round), policy.minScores);
  if (!settled) {
    return {
      ok: false,
      reason:
        `Round ${round} isn't settled yet — ${counted.count} of ${policy.minScores} ` +
        `ballots in. Nothing to send.`,
    };
  }

  const at = now.toISOString();

  // Membership is written *before* the message goes, so the message can say the
  // date. `memberSince` is when the result was sent rather than when the ballots
  // landed: the pass becomes real to them when they're told, and it is the only
  // one of the two timestamps that is certain to exist.
  //
  // The notice markers are cleared with it, and that line is load-bearing: they
  // are keyed by rung, so a renewed member carrying last term's `{"60":…,"30":…,
  // "20":…}` would have every rung of the new term already marked as sent and
  // would never be warned again. A new date means a new ladder.
  //
  // Not for a director. The two of them are Diamonds and will re-audition, but
  // their renewal is a formality — they are the ones judging it — so the bot
  // holding a date over them would be the bot chasing its own judges for a
  // verdict they'd have to give themselves. They keep their membership and get
  // no date and no notices.
  const passed = round === 2 && settled.outcome === "passed";

  // The role, which is the whole point of passing and was the one effect this
  // never had. Before the DM, so the message can't announce a membership that
  // didn't happen — and tolerated rather than fatal, because a result that has
  // been decided should still reach them if Discord is having a bad minute.
  // A director is told instead; they can add it by hand.
  let roleAdded = true;
  if (passed) {
    const roleId = await getDiamondsRoleId(env);
    if (!roleId) {
      roleAdded = false;
    } else {
      try {
        await addRole(env, env.GUILD_DANCE_ID, discordId, roleId);
      } catch (err) {
        console.error("diamonds role", err);
        roleAdded = false;
      }
    }
  }

  const exempt = passed && (await judgesDiamonds(env, await getDiamondDirectorRoleId(env), discordId));
  const promoted: DiamondsRecord =
    passed && !exempt
      ? {
          ...record,
          memberSince: at,
          enforcedAt: enforcementFor(at),
          renewalNoticedAt: undefined,
        }
      : record;

  const reached = await sendDirectMessage(env, discordId, {
    content: resultMessage(
      promoted,
      round,
      settled,
      counted,
      composeFeedback(roundOf(promoted, round), directorIds),
      ctx,
      policy,
    ),
  });
  if (!reached) {
    return {
      ok: false,
      reason:
        `Couldn't DM <@${discordId}>, so nothing has been recorded as sent. Fix ` +
        `their DMs and try again — a result marked sent that never arrived is the ` +
        `worst of both.`,
    };
  }

  const updated = withRound(promoted, round, {
    outcome: settled.outcome,
    outcomeAt: at,
    resultSentAt: at,
    scoredAgainst: settled.against,
  });
  await putRecord(env, updated);
  await refreshReviewCard(env, updated, round, policy);

  return { ok: true, record: updated, round, outcome: settled.outcome };
}
