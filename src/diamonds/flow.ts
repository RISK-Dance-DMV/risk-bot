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
 * emails and nothing posts publicly: every word a dancer receives is a DM or an
 * ephemeral reply, because a score is nobody else's business.
 *
 * Scoring, outcomes and results are **not** here. Round 1 results aren't due
 * until DEC 14 and Round 2's not until JAN 16, and the pure core already holds
 * the decisions (`advancesRound1`, `round2Outcome`) for when they are.
 */
import { isEnabled } from "../config/flags";
import { sendDirectMessage } from "../discord/rest";
import type { MessagePayload } from "../discord/types";
import type { Env } from "../env";
import {
  ROUND_REVEAL,
  canFileDocument,
  canStartWindow,
  canSubmit,
  ballotComplete,
  ballotSplits,
  canPlanStart,
  canSubmitRound0,
  composeFeedback,
  documentReady,
  feedbackRevealed,
  feedbackReady,
  lastStartAt,
  lastRound0At,
  needsPlanReminder,
  needsReminder,
  needsRound0Nudge,
  needsStartHeadsUp,
  needsStartNudge,
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
import { cycleName, resultMessage, roundPanel, type PanelContext } from "./card";
import { getDiamondsTimeline, getDiamondsPolicy, type DiamondsPolicy } from "./config";

const RECORD_PREFIX = "dia:rec:";
/** The process runs two months; a record outliving a year is history, not state. */
const RECORD_TTL = 400 * 24 * 60 * 60;

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
  now: Date,
): Promise<FlowResult> {
  const existing = await getRecord(env, discordId);

  // Someone already on the list is never turned away by the clock — they'd be
  // asking whether they're still in, and after the close they are.
  if (!existing && now.getTime() > new Date(timeline.closesAt).getTime()) {
    return {
      ok: false,
      reason:
        "Auditions have closed, so registration is shut. Ask a director — a late " +
        "entry is their call, not mine.",
    };
  }

  const base: DiamondsRecord = existing
    ? { ...existing, displayName, withdrawnAt: undefined }
    : { discordId, displayName, cohort, registeredAt: now.toISOString(), rounds: {} };

  // The estimate given at registration is Round 0's. Later rounds get their own
  // through `/diamonds plan`, when the piece is actually in front of them.
  const record = plannedStartAt
    ? withRound(base, 0, { plannedStartAt })
    : base;
  await putRecord(env, record);
  return { ok: true, record };
}

/**
 * A director putting someone on the list, deadline or no deadline.
 *
 * The companion to registration refusing late. Refusing was right — the command
 * shouldn't decide whether someone may skip the round everyone else did — but a
 * refusal that points at a director and then gives the director no way to act
 * is just a dead end with better manners.
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
  const record: DiamondsRecord = existing
    ? { ...existing, cohort, withdrawnAt: undefined }
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

  const allowed = canPlanStart(record, round, timeline, policy, day.trim(), now);
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

  const allowed = canStartWindow(record, round, timeline.closesAt, policy.windowDays, now);
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

  const entry = roundOf(record, round);
  const allowed =
    round === 0
      ? canSubmitRound0(timeline.closesAt, now)
      : canSubmit(entry, policy.windowDays, now);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  const updated = withRound(record, round, {
    submissionUrl: link,
    submittedAt: now.toISOString(),
  });
  await putRecord(env, updated);
  return { ok: true, record: updated };
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
  const ready = feedbackReady(record, round);
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

  const open = canFileDocument(timeline.closesAt, now);
  if (!open.ok) return { ok: false, reason: open.reason };

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
    return { ok: true, record: written, warning: ready.reason };
  }

  const delivered = await deliverDocument(env, written, policy, at);
  await putRecord(env, delivered.record);
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
 * Sends a written document and marks it delivered, or doesn't and says so.
 *
 * This is also how Round 0's result is sent, which is why it writes
 * `resultSentAt` and the outcome: the verdict travels inside the document
 * rather than beside it. Nothing is recorded unless the DM actually arrived —
 * a verdict nobody received hasn't been delivered, and marking Round 0 done on
 * a failed send would strand someone with a decision they were never told.
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
    feedbackMessage(
      doc.content,
      doc.strengths,
      doc.growthAreas,
      settled?.outcome === "passed",
      policy,
    ),
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
function feedbackMessage(
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
}> {
  let reminded = 0;
  let nudged = 0;
  let headsUp = 0;
  let round0 = 0;
  let planned = 0;

  const last = Math.floor(
    new Date(lastStartAt(timeline.closesAt, policy.windowDays)).getTime() / 1000,
  );

  for (const record of await allRecords(env)) {
    if (record.withdrawnAt) continue;

    // Carried forward rather than re-read: writing the second round from the
    // unpatched record would quietly drop the first round's marker and send its
    // reminder again tomorrow.
    let current = record;
    let spoke = false;

    for (const round of [1, 2] as Round[]) {
      if (spoke) break;
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

      if (needsStartNudge(entry, timeline.closesAt, policy.windowDays, policy.nudgeDays, now)) {
        await sendDirectMessage(env, current.discordId, {
          content:
            `⏳ **Round ${round}: last chance to start.** Auditions close for ` +
            `everyone, so the last day a ${policy.windowDays}-day window can still ` +
            `shut is <t:${last}:D> (<t:${last}:R>). After that there's nothing ` +
            `anyone can do about it.\nRun \`/diamonds start\` when you're ready.`,
        });
        current = withRound(current, round, { startNudgedAt: now.toISOString() });
        await putRecord(env, current);
        nudged += 1;
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

      if (
        needsStartHeadsUp(
          current,
          round,
          timeline.closesAt,
          policy.windowDays,
          policy.headsUpDays,
          policy.nudgeDays,
          now,
        )
      ) {
        await sendDirectMessage(env, current.discordId, {
          content:
            `👋 **Round ${round}: your piece has been waiting ${policy.headsUpDays} ` +
            `days.** No rush — you have until <t:${last}:D> to start, and the ` +
            `${policy.windowDays} days run from whenever you do.\n` +
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
    if (!spoke && needsRound0Nudge(current, timeline, policy, policy.nudgeDays, now)) {
      const cliff = Math.floor(new Date(lastRound0At(timeline, policy)).getTime() / 1000);
      await sendDirectMessage(env, current.discordId, {
        content:
          `👋 **You registered but haven't sent your Round 0 cover yet.** There's ` +
          `no deadline on it as such, but <t:${cliff}:D> (<t:${cliff}:R>) is the ` +
          `point past which three rounds no longer fit before auditions close.\n` +
          `An existing cover from the last six months is fine — ` +
          `\`/diamonds submit link:<url>\`.`,
      });
      current = withRound(current, 0, { startNudgedAt: now.toISOString() });
      await putRecord(env, current);
      round0 += 1;
    }
  }

  return { reminded, nudged, headsUp, round0, planned };
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
    }
  | { skipped: "flag off" }
> {
  if (!(await isEnabled(env, "diamonds"))) return { skipped: "flag off" };
  const [timeline, policy] = await Promise.all([
    getDiamondsTimeline(env),
    getDiamondsPolicy(env),
  ]);
  return runDiamondsSweep(env, timeline, policy);
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

  const reached = await sendDirectMessage(env, discordId, {
    content: resultMessage(
      record,
      round,
      settled,
      counted,
      composeFeedback(roundOf(record, round), directorIds),
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

  const at = now.toISOString();
  const updated = withRound(record, round, {
    outcome: settled.outcome,
    outcomeAt: at,
    resultSentAt: at,
    scoredAgainst: settled.against,
  });
  await putRecord(env, updated);

  return { ok: true, record: updated, round, outcome: settled.outcome };
}
