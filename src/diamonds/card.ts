/**
 * What a Diamonds auditionee sees. Pure.
 *
 * One panel for all three rounds rather than one per round, because it answers
 * one question — what can I do right now — and three panels would be three
 * places for the answer to drift.
 *
 * Everything here is ephemeral in use. An audition is not a group conversation,
 * and in a reveal-on-start round the piece itself must not be rendered anywhere
 * a second person can read it.
 */
import { ButtonStyle, ComponentType, type MessagePayload } from "../discord/types";
import {
  DIMENSIONS,
  DIMENSION_LABEL,
  ROUND_REVEAL,
  activeRound,
  canStartWindow,
  feedbackWritten,
  roundToScore,
  daysStillNeeded,
  lastRound0At,
  lastStartAt,
  roomForThreeRounds,
  roundOf,
  startWarning,
  visiblePiece,
  windowClosesAt,
  windowState,
  type DiamondsRecord,
  type DiamondsTimeline,
  overallBand,
  tally,
  weightedScore,
  type Round,
  type RoundRecord,
  type Scores,
  type Settled,
  type Split,
  type Tally,
  type Weights,
  type WindowState,
} from "./audition";

export type DiamondsAction = "start" | "doc-save" | "note-save" | "send";

const ACTIONS: DiamondsAction[] = ["start", "doc-save", "note-save", "send"];
const PREFIX = "dia";
const ARG = /^[0-9a-zA-Z:_-]{1,64}$/;

/**
 * `dia|<action>|<arg>`, where arg is a round for the start button and
 * `<dancer>:<dimension>` for the document modal.
 *
 * Notably *not* keyed by the person for the start button. The clicker's own id
 * comes off the interaction, so a button can only ever start the window of
 * whoever pressed it — which is what makes it safe to put the same panel in a
 * DM, an ephemeral reply and a nudge.
 */
export function diamondsCustomId(action: DiamondsAction, arg: string): string {
  return `${PREFIX}|${action}|${arg}`;
}

export function parseDiamondsCustomId(
  value: string,
): { action: DiamondsAction; arg: string } | null {
  const [prefix, action, arg] = value.split("|");
  if (prefix !== PREFIX || !action || !arg) return null;
  if (!ACTIONS.includes(action as DiamondsAction)) return null;
  if (!ARG.test(arg)) return null;
  return { action: action as DiamondsAction, arg };
}

/** Rounds arrive as strings from a custom id; only three of them are rounds. */
export function parseRound(value: string): Round | null {
  return value === "0" || value === "1" || value === "2"
    ? (Number(value) as Round)
    : null;
}

/** Discord renders these in each reader's own timezone. */
function when(iso: string): string {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(unix) ? `<t:${unix}:D> (<t:${unix}:R>)` : iso;
}

function day(iso: string): string {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(unix) ? `<t:${unix}:D>` : iso;
}

export function cycleName(timeline: DiamondsTimeline): string {
  return `Diamonds ${new Date(timeline.closesAt).getUTCFullYear()}`;
}

/** Everything the panels need to know beyond the record itself. */
export interface PanelContext {
  timeline: DiamondsTimeline;
  windowDays: number;
  reviewMinDays: number;
  reviewMaxDays: number;
  /** Only the roster uses this, and only to say what's stuck on one ballot. */
  minScores: number;
}

const START_BUTTON = (round: Round) => ({
  type: ComponentType.ACTION_ROW,
  components: [
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.PRIMARY,
      label: "Start time now",
      custom_id: diamondsCustomId("start", String(round)),
    },
  ],
});

/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/* Round 0                                                                     */
/* -------------------------------------------------------------------------- */

function roundZeroPanel(
  record: DiamondsRecord,
  ctx: PanelContext,
  now: Date,
): MessagePayload {
  const entry = roundOf(record, 0);
  const head = `**Round 0 · ${cycleName(ctx.timeline)}**`;
  const cliff = lastRound0At(ctx.timeline, ctx);
  const room = roomForThreeRounds(ctx.timeline, ctx, now);

  if (record.cohort === "returning") {
    // Nothing is assessed, so there is nothing for them to do but be on the
    // list. Said plainly, because "you're registered and that's all" reads like
    // a missing instruction otherwise.
    const doc = record.document?.deliveredAt
      ? `Your feedback went out ${day(record.document.deliveredAt)}, which means ` +
        `Round 1 is open for you — ask the directors for your piece if it hasn't ` +
        `arrived.`
      : `The directors are writing up your season and deciding whether to take ` +
        `you through. It arrives here as one message — what they saw, and the ` +
        `call — and that message is what opens Round 1 for you.`;
    return {
      content:
        `${head}\n✅ **You're registered.** Round 0 asks nothing of returning ` +
        `Diamonds — no video, nothing to submit.\n${doc}`,
    };
  }

  if (entry.submittedAt) {
    return {
      content:
        `${head}\n✅ **Submitted** ${when(entry.submittedAt)}.\n${entry.submissionUrl ?? ""}\n\n` +
        `We'll come back to you within **${ctx.reviewMinDays}–${ctx.reviewMaxDays} days** with ` +
        `written feedback and whether you're through to Round 1 — one message, ` +
        `both things. You can still replace this with another ` +
        `\`/diamonds submit\` until we do: the last one in is the one we watch.`,
    };
  }

  return {
    content:
      `${head}\n📼 **Post a cover that shows your strengths.** Your own choice of ` +
      `piece, and an existing one from the last six months is fine — you don't ` +
      `have to film something new. It's judged as a yes or a no, not scored: ` +
      `does this belong in the process. Either way you get the feedback.\n` +
      `Submit with \`/diamonds submit link:<url>\`.\n\n` +
      (room
        ? `**There's no fixed deadline for this** — go when you're ready. The one ` +
          `date that matters is ${day(cliff)}: submit after that and there isn't ` +
          `room left for Rounds 1 and 2 before auditions close ${day(ctx.timeline.closesAt)}. ` +
          `Sooner is easier on everyone, yours included.`
        : `⚠️ **Past ${day(cliff)}, so three rounds no longer fit** before auditions ` +
          `close ${day(ctx.timeline.closesAt)}. You're very welcome to submit anyway and ` +
          `get the feedback — just know it can't finish this cycle.`) +
      planLine(entry),
  };
}

/* -------------------------------------------------------------------------- */
/* Rounds 1 and 2                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Their own estimate, or an invitation to make one.
 *
 * Shown on every panel where the next move is theirs, because the estimate is
 * the only thing in a rolling process that puts a date on anything of theirs —
 * and the whole reason it's worth collecting is that a day someone picked
 * themselves is easier to hit than no day at all.
 *
 * Always says it can be moved. A plan that feels like a promise is a plan
 * people avoid making.
 */
function planLine(entry: RoundRecord): string {
  if (entry.plannedStartAt) {
    return (
      `\n\n📌 **You said around ${entry.plannedStartAt}.** I'll remind you that ` +
      `morning. Move it whenever with \`/diamonds plan date:YYYY-MM-DD\` — it was ` +
      `only ever an estimate, and nothing happens if it slips.`
    );
  }
  return (
    `\n\n📌 **Pick a day you'll start and tell me:** ` +
    `\`/diamonds plan date:YYYY-MM-DD\`. You can change it as often as you like ` +
    `and nothing is held against it — but you'll get a reminder that morning, and ` +
    `a day you chose yourself is much easier to hit than no day at all.`
  );
}

function targetLine(record: DiamondsRecord, round: Round): string {
  if (round !== 1 || !record.target) return "";
  const before =
    record.targetBefore === undefined
      ? ""
      : ` We have it at **${record.targetBefore.toFixed(1)}/10** as of the day ` +
        `this piece went up, and that number is now fixed — it was set before ` +
        `anyone had seen what you'd do with it, which is the only way it's worth ` +
        `anything.`;
  return (
    `\n**What this round is looking at:** ${record.target}.${before}\n` +
    `Round 2 scores the four dimensions against the bar; this round doesn't. It ` +
    `scores that one thing against where it started.`
  );
}

/**
 * What a Round 0 row is actually waiting on, which is two things rather than
 * one — the call, and the written feedback that carries it out.
 */
function zeroNote(record: DiamondsRecord): string {
  return record.document ? "needs a pass/fail" : "needs a pass/fail + feedback written";
}

export function roundPanel(
  record: DiamondsRecord,
  round: Round,
  ctx: PanelContext,
  now: Date,
): MessagePayload {
  if (round === 0) return roundZeroPanel(record, ctx, now);

  const entry = roundOf(record, round);
  const head = `**Round ${round} · ${cycleName(ctx.timeline)}**`;
  const state = windowState(entry, ctx.windowDays, now);

  if (state === "submitted") {
    return {
      content:
        `${head}\n✅ **Submitted** ${when(entry.submittedAt!)}.\n` +
        `${entry.submissionUrl ?? ""}\n\n` +
        (round === 1
          ? `We'll come back within **${ctx.reviewMinDays}–${ctx.reviewMaxDays} days** with feedback and, if ` +
            `you're through, your final piece.`
          : `That's everything. We'll come back within **${ctx.reviewMinDays}–${ctx.reviewMaxDays} days**.`) +
        `\nEveryone who submits gets feedback, whether or not they advance.`,
    };
  }

  if (state === "open") {
    const piece = visiblePiece(entry, ROUND_REVEAL[round]);
    const closes = windowClosesAt(entry, ctx.windowDays)!;
    return {
      content:
        `${head}\n⏱️ **Your window is open** — it closes ${when(closes)}.` +
        `${entry.extension ? ` (Includes the ${entry.extension.days}-day extension.)` : ""}\n\n` +
        `**Your piece:**\n${piece}\n\n` +
        `Submit with \`/diamonds submit link:<url>\` before your window closes.` +
        targetLine(record, round),
    };
  }

  if (state === "unavailable") {
    // Rolling rounds mean the wait between rounds is invisible unless someone
    // says how long it is, and an invisible wait is the thing people will
    // actually complain about.
    return {
      content:
        `${head}\n⏳ **Waiting on us.** Your ${round === 1 ? "Round 0" : "Round 1"} ` +
        `submission is being reviewed — usually ` +
        `**${ctx.reviewMinDays}–${ctx.reviewMaxDays} days**, and your feedback and ` +
        `your piece arrive together. Nothing for you to do, and nothing's gone ` +
        `wrong.`,
    };
  }

  const allowed = canStartWindow(record, round, ctx.timeline.closesAt, ctx.windowDays, now);
  if (!allowed.ok) return { content: `${head}\n⚠️ ${allowed.reason}` };

  const last = lastStartAt(ctx.timeline.closesAt, ctx.windowDays);
  return {
    content:
      `${head}\n🎬 **Your piece is ready.** Nobody needs to be here for this — ` +
      `start whenever you're ready to give it ${ctx.windowDays} days.\n\n` +
      `${startWarning(ROUND_REVEAL[round], ctx.windowDays)}\n\n` +
      `No hurry beyond **${day(last)}**, the last day a ${ctx.windowDays}-day window ` +
      `can still shut before auditions close.` +
      targetLine(record, round) +
      planLine(entry),
    components: [START_BUTTON(round)],
  };
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

const STATE_LINE: Record<WindowState, string> = {
  unavailable: "waiting on us",
  "not-started": "ready to start",
  open: "window open",
  lapsed: "window closed",
  submitted: "submitted",
};

/**
 * The whole audition at a glance, under whatever they can do right now.
 *
 * No per-round timeline, because there aren't any any more — one timeline, and you
 * move when you move. What replaces them is the one date that does bind
 * (everything shuts) and the one that's worth knowing (past this, three rounds
 * won't fit).
 */
export function statusPanel(
  record: DiamondsRecord,
  round: Round,
  ctx: PanelContext,
  now: Date,
): MessagePayload {
  const panel = roundPanel(record, round, ctx, now);
  const zero = roundOf(record, 0);

  // Round 0 ends in a pass or a fail now, so the outcome is what to say when
  // there is one. Before that, what's missing differs by cohort: a newcomer
  // owes a cover, a returning Diamond owes nothing and is only waiting.
  const zeroLine =
    zero.outcome === "passed"
      ? "passed"
      : zero.outcome === "failed"
        ? "not through"
        : record.cohort === "returning"
          ? "waiting on your feedback and the call"
          : zero.submittedAt
            ? "submitted — waiting on your feedback and the call"
            : "not submitted";

  const lines = [
    `Round 0 · ${zeroLine}`,
    `Round 1 · ${STATE_LINE[windowState(roundOf(record, 1), ctx.windowDays, now)]}`,
    `Round 2 · ${STATE_LINE[windowState(roundOf(record, 2), ctx.windowDays, now)]}`,
  ];

  return {
    content:
      `${panel.content}\n\n**Where everything stands**\n${lines
        .map((one) => `· ${one}`)
        .join("\n")}\n\n` +
      `Everything shuts ${day(ctx.timeline.closesAt)}. Each window is ${ctx.windowDays} ` +
      `days and we review within ${ctx.reviewMinDays}–${ctx.reviewMaxDays}, so all ` +
      `three rounds need about ${daysStillNeeded(ctx)} days end to end at worst.`,
    components: panel.components,
  };
}

/**
 * Where a round's scoring has got to.
 *
 * Spelled out rather than left as "needs review", because the failure
 * DIAMONDS.md warns about is a round sitting on one ballot against a threshold
 * of two, settling never, and nothing surfacing it. This is what surfaces it.
 */
/** Their estimate for whatever round they're actually in. */
function plannedOf(record: DiamondsRecord, round: Round | null): string | undefined {
  return round === null ? undefined : roundOf(record, round).plannedStartAt;
}

function ballotNote(entry: RoundRecord, minScores: number): string {
  const counted = tally(entry, minScores);
  if (counted.complete) return "**settled — result not sent**";
  return counted.count === 0
    ? "no ballots yet"
    : `⚠️ **${counted.count} of ${minScores} ballots** — waiting on another director`;
}

/**
 * Who's where, in one message.
 *
 * Grouped by **whose move it is**, not by round, because under rolling rounds
 * nobody shares a round — each person is wherever their own record has got to,
 * and the only question a director actually has is what they owe anyone today.
 *
 * The grouping is also why this can't lean on `windowState` alone: Round 0 has
 * no assigned piece by design, so it reads as "unavailable" forever, which for
 * a newcomer who hasn't filmed anything means the opposite of waiting on us.
 */
export function rosterReadout(
  records: readonly DiamondsRecord[],
  ctx: PanelContext,
  now: Date,
): MessagePayload {
  const live = records.filter((one) => !one.withdrawnAt);
  if (live.length === 0) {
    return { content: `**${cycleName(ctx.timeline)}** — nobody registered yet.` };
  }

  type Side = "ours" | "theirs" | "done";
  type Row = { record: DiamondsRecord; round: Round | null; note: string; side: Side };

  const rows: Row[] = live.map((record) => {
    // A director's question is "what do I owe this person", and that is
    // `roundToScore` — *not* the round they're in. Someone who submitted
    // Round 1 is waiting on a Round 2 piece as far as `activeRound` cares,
    // while the thing on the desk is their Round 1 video.
    const scoring = roundToScore(record, ctx.minScores);
    if (scoring !== undefined) {
      const entry = roundOf(record, scoring);
      const since = entry.submittedAt ? ` · in ${day(entry.submittedAt)}` : "";
      return {
        record,
        round: scoring,
        note:
          `${scoring === 0 ? zeroNote(record) : "needs review"}${since} · ` +
          `${ballotNote(entry, ctx.minScores)}`,
        side: "ours",
      };
    }

    const active = activeRound(record, now);
    if (!active.ok) return { record, round: null, note: "finished", side: "done" };

    const round = active.round;
    const entry = roundOf(record, round);

    // The only way to be in Round 0 and not be waiting on us: a newcomer who
    // hasn't sent a cover. Everyone else `roundToScore` has already claimed,
    // since Round 0 stays on our desk until its result has actually gone.
    if (round === 0) {
      return { record, round, note: "no Round 0 cover yet", side: "theirs" };
    }

    const state = windowState(entry, ctx.windowDays, now);
    if (state === "unavailable") {
      return { record, round, note: "needs a piece putting up", side: "ours" };
    }
    if (state === "open") {
      const closes = windowClosesAt(entry, ctx.windowDays);
      return {
        record,
        round,
        note: `dancing${closes ? `, closes ${day(closes)}` : ""}`,
        side: "theirs",
      };
    }
    if (state === "lapsed") {
      return { record, round, note: "window closed with nothing in", side: "theirs" };
    }
    return { record, round, note: "piece up, hasn't started", side: "theirs" };
  });

  const line = ({ record, round, note }: Row) =>
    `· <@${record.discordId}> — ${round === null ? "" : `**R${round}** `}${note}` +
    `${record.cohort === "returning" ? " · returning" : ""}` +
    `${plannedOf(record, round) ? ` · plans ${plannedOf(record, round)}` : ""}` +
    `${round === 1 && record.target ? ` · targeting ${record.target}` : ""}`;

  const ours = rows.filter((one) => one.side === "ours");
  const theirs = rows.filter((one) => one.side === "theirs");
  const done = rows.filter((one) => one.side === "done");

  const parts = [
    `**${cycleName(ctx.timeline)}** — ${live.length} registered, closes ${day(ctx.timeline.closesAt)}`,
    "",
    ours.length > 0
      ? `⏳ **${ours.length} waiting on you** — review within ${ctx.reviewMaxDays} days\n${ours.map(line).join("\n")}`
      : "✅ **Nobody waiting on you.**",
  ];

  if (theirs.length > 0) {
    parts.push("", `🎧 **${theirs.length} with them**\n${theirs.map(line).join("\n")}`);
  }
  if (done.length > 0) {
    parts.push("", `🏁 **${done.length} finished**\n${done.map(line).join("\n")}`);
  }

  return { content: parts.join("\n") };
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The preflight. Every number the audition will run on, and whether it was set
 * or is still the built-in default.
 *
 * Reads as a checklist on purpose, with the flag last: it is the last step of
 * setup rather than the only one, and the failure this exists to prevent is
 * flipping it while the timeline still says what the code shipped with.
 */
export function configReadout(readout: {
  timeline: DiamondsTimeline;
  dateSources: Record<string, "set" | "default">;
  policy: {
    windowDays: number;
    reviewMinDays: number;
    reviewMaxDays: number;
    bar: number;
    floor: number;
    nudgeDays: number;
    headsUpDays: number;
  };
  policySources: Record<string, "set" | "default">;
  timeZone: string;
  roleConfigured: boolean;
  enabled: boolean;
  problems: string[];
}): MessagePayload {
  const mark = (source: "set" | "default") => (source === "set" ? "✅" : "·");
  const { policy } = readout;

  const policyRows = [
    ["diamonds_window_days", "window", `${policy.windowDays} days to learn, record and submit`],
    [
      "diamonds_review_min_days",
      "review turnaround",
      `${policy.reviewMinDays}–${policy.reviewMaxDays} days, promised to them`,
    ],
    ["diamonds_bar", "bar", `${policy.bar} weighted, Round 2 only`],
    ["diamonds_floor", "floor", `${policy.floor} in any one dimension`],
    ["diamonds_start_heads_up_days", "heads-up", `${policy.headsUpDays} days sitting on a piece`],
    ["diamonds_start_nudge_days", "last chance", `${policy.nudgeDays} days before the cliff`],
  ] as const;

  const cliff = lastRound0At(readout.timeline, policy);

  const lines = [
    `**${cycleName(readout.timeline)} — setup**`,
    "",
    `**Timeline** (${readout.timeZone})`,
    `${mark(readout.dateSources.opensAt ?? "default")} opens — ${day(readout.timeline.opensAt)}`,
    `${mark(readout.dateSources.closesAt ?? "default")} closes — ${day(readout.timeline.closesAt)}`,
    `· last useful Round 0 — ${day(cliff)} *(derived, not set)*`,
    "",
    "**Numbers**",
    ...policyRows.map(
      ([key, label, value]) =>
        `${mark(readout.policySources[key] ?? "default")} ${label} — ${value}`,
    ),
    "",
    "**Everything else**",
    `${readout.roleConfigured ? "✅" : "⚠️"} \`config:role.diamonds\` — ${
      readout.roleConfigured
        ? "set, so returning Diamonds are recognised"
        : "not set, so **everyone counts as new** and Round 0 will ask them all for a cover"
    }`,
    `${readout.enabled ? "✅" : "⬜"} \`config:features.diamonds\` — ${
      readout.enabled ? "**on**" : "off, so every subcommand but this one refuses"
    }`,
  ];

  if (readout.problems.length > 0) {
    lines.push("", "**This timeline can't be run:**", ...readout.problems.map((one) => `❌ ${one}`));
  }

  // A dot rather than a cross against a default: shipping-default is a
  // perfectly good answer when it matches the announcement, and the only way
  // to know whether it does is to read the timeline — which is what this is for.
  lines.push(
    "",
    "`·` means still on the built-in default. That's fine where it matches what " +
      "you announced — check the two timeline above against the announcement, then " +
      "turn the flag on.",
  );

  return { content: lines.join("\n") };
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

function scoreLine(scores: Scores, weights: Weights): string {
  const parts = DIMENSIONS.map(
    (one) => `${DIMENSION_LABEL[one]} **${scores[one].toFixed(2)}**`,
  );
  return `${parts.join(" · ")}\nWeighted **${weightedScore(scores, weights).toFixed(2)}**`;
}

function splitWarning(splits: readonly Split[]): string {
  if (splits.length === 0) return "";
  const lines = splits.map(
    ({ what, low, high }) =>
      `· ${what === "target" ? "the target" : DIMENSION_LABEL[what]} — ${low} vs ${high}`,
  );
  return (
    `\n\n⚠️ **More than one anchor step apart on:**\n${lines.join("\n")}\n` +
    `The mean of 4 and 9 looks exactly like the mean of 6 and 7 and means ` +
    `something completely different, so this is worth a conversation before the ` +
    `result goes out. Rescore with \`/diamonds score\` if either of you wants to move.`
  );
}

/**
 * What a director sees after scoring.
 *
 * Shows nothing but a count while the tally is incomplete — that's the seal. A
 * director part-way through a cohort can see how many ballots are in and no
 * more, because with two directors the first number would otherwise decide the
 * second.
 */
export function ballotReceipt(
  record: DiamondsRecord,
  round: Round,
  counted: Tally,
  splits: readonly Split[],
  settled: Settled | undefined,
  policy: { minScores: number; weights: Weights; bar: number; floor: number },
): MessagePayload {
  const head = `**<@${record.discordId}> · Round ${round}**`;

  const written = feedbackWritten(roundOf(record, round));
  const notesLine =
    round === 0
      ? ""
      : `\nFeedback: ${written.length} written` +
        (written.length > 0 ? ` (${written.map((id) => `<@${id}>`).join(", ")})` : "") +
        `. \`/diamonds feedback\` any time, before or after your ballot.`;

  if (!counted.complete) {
    const outstanding = Math.max(0, policy.minScores - counted.count);
    return {
      content:
        `${head}\n✅ **Your ballot is in.** ${counted.count} of ` +
        `${policy.minScores}, so ${outstanding} still to come — and you won't see ` +
        `anyone else's until they are, which is deliberate.\n` +
        `Nothing has been sent to them and nothing is decided yet.${notesLine}` +
        (round === 0 ? "" : " Text stays hidden until the round settles."),
    };
  }

  const lines = [`${head}\n✅ **All ${counted.count} ballots in.**`];

  if (round === 0) {
    lines.push(
      "",
      counted.verdict === "split"
        ? `⚠️ **One pass, one fail.** Nothing settles on that — there's no ` +
          `tiebreak here and no average to take. Talk it through and whichever ` +
          `of you moves, score again.`
        : counted.verdict === "pass"
          ? settled
            ? `🎉 **Through to Round 1.**`
            : `🎉 **Both of you say pass.**`
          : settled
            ? `🚫 **Not through.**`
            : `🚫 **Both of you say fail.**`,
    );
    if (counted.verdict !== "split") {
      lines.push(
        record.document?.deliveredAt
          ? `Sent — the verdict went out inside their feedback.`
          : record.document
            ? `Their feedback is written and goes out with this. Nothing has ` +
              `reached them yet.`
            : `Nothing has reached them yet: Round 0's result **is** their ` +
              `feedback, so write it with \`/diamonds feedback\` and it sends ` +
              `itself.`,
      );
    }
    return { content: lines.join("\n") + splitWarning(splits) };
  }

  if (round === 1 && settled?.advancement) {
    const { before, after, steps, because } = settled.advancement;
    lines.push(
      "",
      `**${record.target ?? "the target"}:** ${before.toFixed(2)} → ${after.toFixed(2)} ` +
        `(${steps.toFixed(1)} anchor steps)`,
      settled.outcome === "advanced"
        ? because === "already-there"
          ? `🎉 **Advances** — already at the bar on this and didn't regress.`
          : `🎉 **Advances** — moved ${steps.toFixed(1)} steps, needed 1.`
        : `🚫 **Doesn't advance** — no real movement on the thing we named.`,
    );
  }

  if (round === 2 && counted.scores) {
    lines.push("", scoreLine(counted.scores, policy.weights), "", overallBand(counted.scores, policy.bar));
    lines.push(
      settled?.outcome === "passed"
        ? `🎉 **Passes** — clears ${policy.bar} with nothing below ${policy.floor}.`
        : `🚫 **Doesn't pass** against ${policy.bar} / floor ${policy.floor}.`,
    );
  }

  lines.push(
    "",
    settled
      ? `Nothing has reached them yet. \`/diamonds result\` to read it back and send it.${notesLine}`
      : `Not settled yet — something's missing from the ballots.`,
  );
  return { content: lines.join("\n") + splitWarning(splits) };
}

/**
 * The result, as the dancer will read it, for a director to check before it
 * goes.
 *
 * Previewed rather than sent straight off the scoring command because this is
 * the one irreversible step in the whole process. Everything else can be
 * corrected; a result cannot be unsent.
 */
export function resultMessage(
  record: DiamondsRecord,
  round: Round,
  settled: Settled,
  counted: Tally,
  feedback: string,
  ctx: PanelContext,
  policy: { weights: Weights; bar: number; floor: number },
): string {
  const name = cycleName(ctx.timeline);
  // Appended rather than woven in, so a director's own words arrive as their
  // own words rather than as part of a generated verdict.
  const notes = feedback.trim()
    ? `\n\n**What the directors wrote**\n\n${feedback.trim()}`
    : "";

  if (round === 1) {
    const moved = settled.advancement;
    const delta = moved
      ? `\n\n**${record.target ?? "What we asked you to work on"}:** ` +
        `${moved.before.toFixed(1)} before, **${moved.after.toFixed(1)}** now.`
      : "";
    return settled.outcome === "advanced"
      ? `**${name} — Round 1**\n\n🎉 **You're through to Round 2.**${delta}\n\n` +
          (moved?.because === "already-there"
            ? `You were already strong there and held it, which counts.`
            : `That's real movement on the thing we named, which is exactly what ` +
              `this round was asking for.`) +
          `\n\nYour final piece will arrive here. Everyone dances the same one, you ` +
          `get it privately when you start, and you'll have ${ctx.windowDays} days.` +
          notes
      : `**${name} — Round 1**\n\n🚫 **Not through to Round 2 this time.**${delta}\n\n` +
          `That's the one thing this round measured, and it didn't move enough to ` +
          `carry you forward. It isn't a verdict on you as a dancer and it isn't ` +
          `the end of anything — keep working on it, and audition again. We'd ` +
          `rather you did.` + notes;
  }

  const scores = counted.scores;
  const detail = scores
    ? `\n\n${DIMENSIONS.map((one) => `· ${DIMENSION_LABEL[one]} — **${scores[one].toFixed(1)}**`).join("\n")}\n` +
      `Weighted: **${weightedScore(scores, policy.weights).toFixed(2)}**`
    : "";

  return settled.outcome === "passed"
    ? `**${name} — Round 2**\n\n🎉 **You've passed.** Welcome to Diamonds.${detail}\n\n` +
        `You cleared ${policy.bar} with nothing below ${policy.floor}. A director ` +
        `will be in touch about what happens next.` + notes
    : `**${name} — Round 2**\n\n🚫 **Not this cycle.**${detail}\n\n` +
        `The bar was ${policy.bar} weighted, with nothing below ${policy.floor} in ` +
        `any one area. Those are your actual numbers, not a softened version — ` +
        `you're welcome to them and welcome to ask us about any of them.\n\n` +
        `Getting this far is not nothing, and there'll be another audition.` + notes;
}
