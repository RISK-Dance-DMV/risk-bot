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
  MAX_ASK_DAYS,
  ROUND_REVEAL,
  askableRound,
  requestPending,
  type ExtensionAsk,
  canStartWindow,
  canSubmit,
  ballotComplete,
  ballotSplits,
  auditionFinished,
  auditionResulted,
  retryBlocked,
  retryBlockedUntil,
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
  needsRound0Nudge,
  needsReminder,
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
  askCard,
  feedbackArrived,
  feedbackRefused,
  resultComponents,
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
  /**
   * Their Round 0 cover, because registering **is** submitting it.
   *
   * The two used to be separate steps with an estimated date in between, and
   * the gap was the single biggest source of people going quiet: you could put
   * your name down, mean it, and never send anything — and the bot's whole
   * answer to that was a nudge. Asking for the cover at the door removes the
   * state entirely. There is no longer such a thing as registered-but-not-
   * started.
   *
   * Newcomers only. A returning Diamond owes no cover, so this is undefined for
   * them and the round is decided on their season.
   */
  cover: string | undefined,
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

  // The cover, which is the registration. Only a newcomer owes one, and only if
  // they haven't already got one in — running the command again to check you're
  // on the list shouldn't need the link a second time.
  const owes = base.cohort === "new" && !roundOf(base, 0).submittedAt;
  const link = cover?.trim();
  if (owes && !link) {
    return {
      ok: false,
      reason:
        "Registering **is** sending your Round 0 cover, so it needs a link: " +
        "`/diamonds register cover:<url>`.\n" +
        "Your own choice of piece, and an existing one from the last six months " +
        "is fine — you don't have to film anything new. It's judged as a yes or " +
        "a no rather than scored, and you get written feedback either way.",
    };
  }
  if (link && !/^https?:\/\/\S+$/i.test(link)) {
    return { ok: false, reason: "That doesn't look like a link. Paste the full URL." };
  }

  const record =
    link && base.cohort === "new"
      ? withRound(base, 0, { submissionUrl: link, submittedAt: now.toISOString() })
      : base;
  await putRecord(env, record);

  // **The review card goes up on registration**, because registration is now a
  // submission. Merging the two commands left this behind: a cover that arrived
  // with a registration recorded a Round 0 submission and posted no card, so the
  // only way a director saw it was `/diamonds roster` — the one place nobody is
  // looking when they aren't expecting anybody.
  //
  // For a returning Diamond too, who sends nothing. Their Round 0 is decided on
  // the season already watched, so it is reviewable the instant they register
  // and the card is what says so.
  //
  // Written first, posted second, written again with the message id — the same
  // two-write order `submit` uses, for the same reason: a registration that
  // survives a Discord outage and loses its card is a bad morning, and one that
  // is lost because the card couldn't be posted is a lost audition.
  const carded = await postReviewCard(env, record, 0, policy);
  if (carded !== record) await putRecord(env, carded);
  return { ok: true, record: carded };
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

  // `expiredAt` clears with `withdrawnAt`, and this is now the only door that
  // clears it: a run that ran out of days is reopened by a director putting the
  // person back on, mid-round, exactly as a dropped one is. It also resets the
  // clock, because `registeredAt` is what the 60 days count from and somebody
  // being let back in needs days to use rather than a date that has gone.
  const record: DiamondsRecord = carried
    ? {
        ...carried,
        cohort,
        withdrawnAt: undefined,
        ...(carried.expiredAt
          ? { expiredAt: undefined, registeredAt: now.toISOString(), runWarnedAt: undefined }
          : {}),
      }
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

  // **The piece goes up before the feedback goes out, and sends it.**
  //
  // The ordering used to be the other way round, and it put the dancer in a
  // state nobody wanted: reading the document opened Round 1, so a read that
  // arrived before a director had chosen a piece landed them on a panel saying
  // "waiting on us". Now the document is written whenever, held, and released
  // by this call — one message to them, with the piece already behind it.
  //
  // So nothing is refused here. `documentReady` is where the waiting lives, and
  // the only requirement left on a director is to write the feedback at some
  // point; the order they do the two in no longer matters.
  const held = round === 1 && !!record.document && !record.document.deliveredAt;

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

  // The held document, if this call is what unblocked it. One message rather
  // than two: the notice is the thing that tells them there's a piece, and a
  // separate "your piece is up" beside it would be the same news twice.
  if (held) {
    const ready = documentReady(updated, policy.minScores);
    if (ready.ok) {
      const delivered = await deliverDocument(env, updated, policy, now.toISOString());
      await putRecord(env, delivered.record);
      await refreshReviewCard(env, delivered.record, 0, policy);
      return {
        ok: true,
        record: delivered.record,
        warning: delivered.reached
          ? undefined
          : `Piece is up, but couldn't DM <@${discordId}> — so their feedback hasn't ` +
            `gone and Round 1 hasn't opened. Fix their DMs and run this again.`,
      };
    }
  }

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
    // No `bar` and no `requiredSteps`. The panels are what a dancer reads, and
    // nothing they read contains a score — so the context they're built from
    // can't reach one either.
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
      `⏳ **That's granted** — Round ${round} now closes <t:${unix}:D> ` +
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
  if (!delivered.reached) await dmClosed(env, discordId, "their Round 0 result");
  return {
    ok: true,
    record: delivered.record,
    warning: delivered.reached
      ? undefined
      : `Written, but couldn't DM <@${discordId}> — saved as undelivered, so ` +
        `Round 1 has **not** opened for them. Details in ` +
        `#${env.CH_DIRECTORS_CONFIRMATION}; file it again once their DMs are open.`,
  };
}

/**
 * Sends the document, and marks it delivered.
 *
 * This is also how Round 0's result is sent, which is why it writes
 * `resultSentAt` and the outcome: the verdict travels inside the document
 * rather than beside it. One message either way — a pass carries Round 1's
 * start button, a fail carries the practice offer.
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
  const passed = settled?.outcome === "passed";

  // Both get the whole document. Nothing a dancer is owed sits behind a click,
  // and the feedback is owed either way — what differs is what comes after it:
  // a pass has a button to the next round, a fail has one to practice.
  const written = feedbackMessage(doc.content, doc.strengths, doc.growthAreas);
  const reached = await sendDirectMessage(
    env,
    record.discordId,
    passed
      ? feedbackArrived(written, policy.windowDays)
      : feedbackRefused(written, policy.windowDays),
  );
  if (!reached) return { record, reached };
  return {
    record: withRound(
      {
        ...record,
        document: { ...doc, deliveredAt: at },
      },
      0,
      { resultSentAt: at, outcome: settled?.outcome, outcomeAt: at },
    ),
    reached: true,
  };
}

/**
 * A dancer taking the practice offer after a Round 0 fail.
 *
 * Theirs to decide, which is why it's a button on their own message rather than
 * something a director grants: the question is whether they want to dance it,
 * and nobody else can answer that.
 *
 * `practiceFrom: 1` leaves Round 0's fail exactly where it is — the same way a
 * Round 1 carry keeps its fail. The verdict stands; what changes is that there
 * are two more rounds after it.
 */
export async function takePractice(env: Env, discordId: string): Promise<FlowResult> {
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: "You're not registered for this audition." };
  }
  if (record.practiceFrom !== undefined) {
    return { ok: false, reason: "You're already down as practice — nothing to change." };
  }

  // Whichever round didn't go through — practice starts after it. Round 0's
  // fail puts them in Round 1, Round 1's in Round 2. Round 2 has no round after
  // it, so there's nothing to offer and nothing to take.
  const failed = ([0, 1] as Round[]).find((round) => roundOf(record, round).outcome === "failed");
  if (failed === undefined) {
    return {
      ok: false,
      reason:
        "That offer goes with a round we didn't take through, and you haven't " +
        "got one. Nothing to do here.",
    };
  }

  const practising: DiamondsRecord = { ...record, practiceFrom: (failed + 1) as Round };
  await putRecord(env, practising);
  return { ok: true, record: practising };
}

/**
 * The written feedback, and nothing else.
 *
 * **No verdict in here.** It carried one — a closing paragraph per outcome —
 * and both of them said what the message wrapping this already said, word for
 * word in the case of a fail. The wrapper owns the decision and what happens
 * next; this owns what the directors actually watched. One fact, one place.
 */
export function feedbackMessage(
  content: string,
  strengths: readonly string[],
  growthAreas: readonly string[],
): string {
  const list = (items: readonly string[]) => items.map((one) => `· ${one}`).join("\n");
  return (
    `${content}\n\n` +
    `**What you brought**\n${list(strengths)}\n\n` +
    `**Where to grow**\n${list(growthAreas)}`
  );
}

/**
 * A dancer asking for more days.
 *
 * The counterpart to a director being able to grant them, and the thing that
 * made "talk to a director" a flow rather than a conversation: the refusals
 * point at a director, and until now there was no way to reach one from inside
 * the process.
 *
 * Posts the question to #audition-review and keeps the message id, so the
 * answer can edit the same message rather than leaving a stale ask above a
 * fresh outcome. A failed post is fatal to the ask on purpose — a request
 * recorded where nobody can see it is worse than one that didn't go through,
 * because the dancer would be waiting on a question nobody has.
 */
export async function askForDays(
  env: Env,
  discordId: string,
  days: number,
  reason: string,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  const record = await getRecord(env, discordId);
  if (!record) return { ok: false, reason: "You're not registered for this audition." };
  if (requestPending(record)) {
    return {
      ok: false,
      reason:
        "You've already asked — the directors have it and nobody has answered " +
        "yet. Asking twice doesn't make it arrive twice.",
    };
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_ASK_DAYS) {
    return { ok: false, reason: `Ask for between 1 and ${MAX_ASK_DAYS} days.` };
  }
  if (!reason.trim()) {
    return {
      ok: false,
      reason: "Say what's happened — a director is answering a person, not a form.",
    };
  }

  // Only an open window. Nothing to extend otherwise, and that's a refusal
  // rather than a fallback to the 60 days: the 60 are generous enough that
  // running out of them isn't a timing problem, and somebody who hasn't started
  // a window has all the time they need already.
  const round = askableRound(record, policy.windowDays, now);
  if (round === undefined) {
    return {
      ok: false,
      reason:
        "You've no window open, so there's nothing to extend — the clock that " +
        "matters starts when you press start, and nothing is running down while " +
        "you wait. If something bigger is in the way, say so in #diamonds-bot " +
        "and a director can move your whole deadline.",
    };
  }

  const ask: ExtensionAsk = {
    days,
    reason: reason.trim(),
    at: now.toISOString(),
    round,
  };

  let posted: { id: string; channelId: string };
  try {
    posted = await postToChannelByName(
      env,
      env.GUILD_COMMUNITY_ID,
      env.CH_AUDITION_REVIEW,
      askCard({ ...record, request: ask }, ask, policy.windowDays),
    );
  } catch (err) {
    console.error("diamonds ask", err);
    return {
      ok: false,
      reason:
        "Couldn't get that to the directors, so I haven't recorded it — better " +
        "you know than wait on a question nobody has. Try again, or message a " +
        "director directly.",
    };
  }

  const asked: DiamondsRecord = {
    ...record,
    request: { ...ask, messageId: posted.id, channelId: posted.channelId },
  };
  await putRecord(env, asked);
  return { ok: true, record: asked };
}

/**
 * A director's answer, which is the whole of what the two buttons do.
 *
 * Granting reuses the existing extension paths rather than reimplementing them,
 * so an extension asked for and an extension given unprompted are the same
 * write — including the bits that are easy to forget, like clearing the
 * reminder marker so the new deadline gets its own warning.
 *
 * A denial needs a note. "No" without a reason just invites asking again, and
 * the dancer is told what was written.
 */
export async function answerAsk(
  env: Env,
  discordId: string,
  by: string,
  granted: boolean,
  note: string,
  policy: DiamondsPolicy,
  now: Date,
): Promise<FlowResult> {
  const record = await getRecord(env, discordId);
  if (!record) {
    return { ok: false, reason: `<@${discordId}> isn't registered for this audition.` };
  }
  if (!requestPending(record)) {
    return { ok: false, reason: `There's no open request from <@${discordId}>.` };
  }
  if (!granted && !note.trim()) {
    return { ok: false, reason: "A denial needs a reason — they're told what you write." };
  }

  const ask = record.request!;
  if (granted) {
    const applied = await grantExtension(
      env,
      discordId,
      ask.round,
      ask.days,
      ask.reason,
      by,
      policy,
    );
    // Refused by the thing that would have done the work — a window that closed
    // while the ask sat there, say. Said as it came back rather than translated:
    // a director needs to know which clock refused and why.
    if (!applied.ok) return applied;
  }

  // Re-read, because granting wrote the record. Writing the answer from the
  // copy taken before that would drop the extension it just granted.
  const after = (await getRecord(env, discordId)) ?? record;
  const answered: DiamondsRecord = {
    ...after,
    request: {
      ...ask,
      granted,
      by,
      answeredAt: now.toISOString(),
      ...(note.trim() ? { note: note.trim() } : {}),
    },
  };
  await putRecord(env, answered);

  if (ask.messageId && ask.channelId) {
    try {
      await editMessage(
        env,
        ask.channelId,
        ask.messageId,
        askCard(answered, answered.request!, policy.windowDays),
      );
    } catch (err) {
      console.error("diamonds ask card", err);
    }
  }

  // Granting already DMs them the new deadline, so only a denial has news.
  if (!granted) {
    await sendDirectMessage(env, discordId, {
      content:
        `**We can't give you the extra time on this one**, so your deadline ` +
        `stands as it was.\n> ${note.trim().split("\n").join("\n> ")}\n\n` +
        `Sorry to say no. If any of that needs explaining, ask a director.`,
    });
  }

  return { ok: true, record: answered };
}

/**
 * The two-month refusal, shared by starting and submitting.
 *
 * Says the date and points at a director, because by the time anyone reads this
 * the only thing that can help is somebody who can put them back on the list —
 * and they would much rather do that than have this be the end of it.
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
      `Your ${policy.runDays} days ran out on <t:${unix}:D>, so this audition ` +
      `is closed. You're welcome to audition again once the ` +
      `${policy.retryMonths}-month wait is up — \`/diamonds status\` has the ` +
      `date.`,
  };
}


/**
 * Says so in the directors' channel when a DM bounces, and says what to do.
 *
 * A dancer with DMs off is invisible to this whole process *from their own
 * side*: everything they'd be told arrives by DM, so they see nothing, assume
 * nothing has happened, and wait. Nobody finds out until a director notices a
 * result that won't send. The bot can't reach them to say "open your DMs" —
 * that's the whole problem — so the only place the fact can usefully land is
 * where the two people who *can* reach them are looking.
 *
 * Carries the fix rather than just the failure, because the first question is
 * always "how do they turn that on" and it isn't obvious.
 */
async function dmClosed(env: Env, discordId: string, what: string): Promise<void> {
  await alertDirectors(
    env,
    `⚠️ **Couldn't DM <@${discordId}>** — ${what} hasn't reached them, and ` +
      `nothing has been recorded as sent.\n` +
      `Almost always one setting on their side: **User Settings → Privacy & ` +
      `Safety → Allow direct messages from server members**, which can also be ` +
      `switched off per-server from the RISK Dance server menu. Ask them to turn ` +
      `it on, then run it again.\n` +
      `Until then they can see nothing of their audition, so they won't know ` +
      `anything is waiting.`,
  );
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
/* -------------------------------------------------------------------------- */
/* The daily sweep                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The daily pass. Everything in it is keyed to one person's own dates, because
 * after the close date went there are no shared ones left.
 *
 *   window closing   T−1 of their own close time, whoever's window is open
 *   their own date   the day they said they'd start this round
 *   heads-up         ten days sitting on a piece they haven't started
 *   no cover yet     ten days on the list with nothing in — `add` only
 *   run warning      ten days before their 60 are up
 *   run closed       the 60 are up with the rounds unfinished
 *   lapse            their membership date has passed
 *   renewal ladder   60, 30 and 20 days out, most urgent only
 *
 * **One message per person per morning**, and the order above is the order the
 * checks run in — a sweep that can send two things to one person is a sweep
 * nobody trusts the third time. Two exceptions, both deliberate: the run
 * closing and the lapse are not messages but endings, so they sit outside the
 * rule rather than queueing behind an open window's reminder.
 *
 * The heads-up and the no-cover nudge are the ones that matter most. Everything
 * else keys off a window being open or a date approaching, so none of it can
 * reach the person who is simply not starting — and that person is the likeliest
 * to lose a round to nothing at all.
 *
 * It also alerts the directors, once a morning, about ballots they owe past the
 * promised turnaround. That one repeats on purpose: it's the only message here
 * about work still outstanding rather than a moment that has passed.
 */
export async function runDiamondsSweep(
  env: Env,
  timeline: DiamondsTimeline,
  policy: DiamondsPolicy,
  now = new Date(),
): Promise<{
  reminded: number;
  nudged: number;
  /** Kept at 0: the sitting-on-a-piece nudge went with the plan reminder. */
  headsUp: number;
  /** On the list with no cover in — only reachable via `/diamonds add`. */
  round0: number;
  /** Kept at 0: the planned-start reminder went, the estimate stayed. */
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
  const overdue: { discordId: string; round: Round; days: number }[] = [];
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

    // Anything that has been sitting on a director's desk longer than the
    // turnaround we promised. Collected here and sent as one message after the
    // loop, because two directors do not want a DM per dancer — and because the
    // useful form of this is a list, which is what makes it obvious when one
    // person has been waiting much longer than the rest.
    if (!quiet) {
      const owed = roundToScore(current, policy.minScores);
      if (owed !== undefined) {
        const since = roundOf(current, owed).submittedAt ?? current.registeredAt;
        const waited = since
          ? Math.floor((now.getTime() - new Date(since).getTime()) / (24 * 60 * 60 * 1000))
          : 0;
        if (waited > policy.reviewMaxDays) {
          overdue.push({ discordId: current.discordId, round: owed, days: waited });
        }
      }
    }

    for (const round of [1, 2] as Round[]) {
      if (spoke || quiet) break;
      const entry = roundOf(current, round);

      if (needsReminder(entry, policy.windowDays, now)) {
        const closes = windowClosesAt(entry, policy.windowDays)!;
        const unix = Math.floor(new Date(closes).getTime() / 1000);
        await sendDirectMessage(env, current.discordId, {
          content:
            `⏰ **Round ${round} closes <t:${unix}:R>.** Submit with ` +
            `\`/diamonds submit link:<url>\` before then.\n` +
            `If something's gone wrong, there's an **Ask for more time** button ` +
            `on your panel.`,
        });
        current = withRound(current, round, { remindedAt: now.toISOString() });
        await putRecord(env, current);
        reminded += 1;
        spoke = true;
        continue;
      }

      // Two messages used to sit here: "you said you'd start today", and "your
      // piece has been waiting ten days". Both are gone. The 60-day clock
      // reminds people on its own schedule and does it once; a bot that also
      // chases you about a date you volunteered, and again about a piece you
      // haven't got round to, is three messages for one fact.
    }

    // On the list with no cover in.
    //
    // Registering is sending the cover now, so a dancer can't put themselves in
    // this state — but `/diamonds add` still can, and someone a director added
    // is the person least likely to know what they owe. Narrower than it was
    // and worth keeping for exactly that.
    if (!spoke && !quiet && needsRound0Nudge(current, policy.headsUpDays, now)) {
      await sendDirectMessage(env, current.discordId, {
        content:
          `**Round 0 — we don't have your cover yet.**\n\n` +
          `A director put you on the Diamonds list rather than you registering ` +
          `yourself, so this may well be the first you've heard of it. Round 0 ` +
          `is a video of your own choosing, and an existing one from the last six ` +
          `months is absolutely fine — nothing to film.\n\n` +
          `Send it over with \`/diamonds submit link:<url>\` whenever suits. If ` +
          `you're not sure what this is, ask a director and they'll fill you in.`,
      });
      current = withRound(current, 0, { startNudgedAt: now.toISOString() });
      await putRecord(env, current);
      round0 += 1;
      spoke = true;
    }

    // There was an "unopened feedback" nudge here, for a dancer who had been
    // sent their pass and not pressed the button that opened Round 1. The
    // button went — the pass now carries the start button itself — and the state
    // went with it: somebody who hasn't started is in the ordinary
    // not-started-yet state, which the heads-up above already covers.

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
            `**${left} days left on your audition.**\n\n` +
            `All three rounds need to be finished by <t:${ends}:D> — the ` +
            `${policy.runDays} days run from when you registered. A round takes ` +
            `${policy.windowDays} days and we turn feedback round within ` +
            `${policy.reviewMinDays}–${policy.reviewMaxDays}, so there's still ` +
            `room to do this comfortably.\n\n` +
            `If you're not sure where you are, \`/diamonds status\` will tell ` +
            `you, and a director can help if something's unclear.`,
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
          `**Your audition has closed.**\n\n` +
          `The ${policy.runDays} days for all three rounds are up, so this one ` +
          `finishes without a result. Thanks for the part of it you did.\n\n` +
          `**You can audition again from <t:${Math.floor(
            new Date(
              retryBlockedUntil({ ...current, expiredAt: now.toISOString() }, policy.retryMonths) ??
                now.toISOString(),
            ).getTime() / 1000,
          )}:D>.** Registering then starts a new audition from Round 0.\n\n` +
          `If something got in the way of this one, do say so to a director — ` +
          `it's useful for us to know.`,
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
            `**Your Diamonds membership has ended.**\n\n` +
            `It ran to <t:${ranTo}:D>, and membership is renewed by ` +
            `re-auditioning — so the role has come off for now.\n\n` +
            `**You can re-audition whenever you like.** Register and you go ` +
            `through the three rounds like anyone else; passing puts you back on ` +
            `with a new date. We'd be glad to see you go again.\n\n` +
            `Any questions, just ask a director.`,
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

  // One message to the two of them, every morning there is anything late.
  //
  // No marker and no "once": unlike every dancer-facing message here, this one
  // is about work that is still outstanding, so repeating it daily is the point
  // and it stops the day the list empties. Sorted longest-waiting first, since
  // that is the one that has to move.
  if (overdue.length > 0) {
    const lines = overdue
      .sort((a, b) => b.days - a.days)
      .map((one) => `· <@${one.discordId}> — Round ${one.round}, **${one.days} days**`);
    await alertDirectors(
      env,
      `⏰ **${overdue.length} waiting on a ballot longer than the ` +
        `${policy.reviewMaxDays} days we promise:**\n${lines.join("\n")}\n` +
        `Their ${policy.runDays} days keep running while they wait, so this is the ` +
        `thing most likely to cost somebody an audition they'd have finished. ` +
        `\`/diamonds roster\` has the rest.`,
    );
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
        `**Your Diamonds membership runs to ${date}.**\n\n` +
        `You can't re-audition before <t:${until}:D> — that's the ` +
        `${policy.retryMonths}-month wait after an audition that didn't go ` +
        `through, and it runs past your renewal date. So as things stand the ` +
        `role comes off on ${date}.\n\n` +
        `Worth a word with a director if you'd like to talk it through.`,
    };
  }
  const needed = policy.reviewMaxDays + policy.windowDays + policy.reviewMaxDays + policy.windowDays;
  const final = policy.noticeDays[0] ?? 0;

  if (daysLeft > (policy.noticeDays[1] ?? 30)) {
    return {
      content:
        `**Your Diamonds membership runs to ${date}** — about two months away.\n\n` +
        `Membership is renewed by re-auditioning, and passing sets a new date. ` +
        `**Auditioning in October or April gives you the longest next term** — ` +
        `about fifteen months — because your date is set by the half of the year ` +
        `you audition in. Leaving it to March or September gives you about nine.\n\n` +
        `Nothing to do today — just worth knowing the date. Any questions, ask ` +
        `a director.`,
    };
  }

  if (daysLeft > final) {
    return {
      content:
        `**A month to ${date}**, when your Diamonds membership is up for ` +
        `renewal.\n\n` +
        `A re-audition takes about ${needed} days end to end — three rounds, ` +
        `two windows and our turnaround — so this is a good point to start ` +
        `thinking about which week suits. \`/diamonds status\` has where you ` +
        `stand.\n\n` +
        `Any questions, ask a director.`,
    };
  }

  return {
    content:
      `**${daysLeft} days to ${date}.**\n\n` +
      `That's about as long as a re-audition takes, so renewing this term means ` +
      `starting about now. If you haven't re-auditioned by ${date} the Diamonds ` +
      `role comes off, and you'd be welcome to audition again whenever you ` +
      `like.\n\n` +
      `Any questions, ask a director.`,
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

  // **No result goes out without written feedback.** The scores don't reach the
  // dancer at all now, so the note is the entire body of the message — without
  // one this would send a bare verdict, which is the thing the whole shape of
  // these messages exists to avoid. Refused rather than padded: a generated
  // sentence standing in for a director's reading would be worse than waiting.
  const written = composeFeedback(roundOf(record, round), directorIds).trim();
  if (!written) {
    return {
      ok: false,
      reason:
        `Nothing written for Round ${round} yet, and the result **is** the ` +
        `feedback — scores don't go to the dancer, so there'd be no message here ` +
        `beyond the verdict. Write it with \`/diamonds feedback\` or the **Note** ` +
        `button, then send.`,
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
    content: resultMessage(promoted, round, settled, written, ctx, now),
    components: resultComponents(promoted, round, settled),
  });
  if (!reached) {
    await dmClosed(env, discordId, `their Round ${round} result`);
    return {
      ok: false,
      reason:
        `Couldn't DM <@${discordId}>, so nothing has been recorded as sent — a ` +
        `result marked sent that never arrived is the worst of both. I've put ` +
        `the details in #${env.CH_DIRECTORS_CONFIRMATION}; try again once their ` +
        `DMs are open.`,
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
