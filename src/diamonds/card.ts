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
  auditionNumber,
  canStartWindow,
  retryBlocked,
  feedbackWritten,
  roundToScore,
  anyPractice,
  askableRound,
  requestPending,
  isPractice,
  roundOf,
  runDaysLeft,
  runEndsAt,
  targetToBeat,
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
  type ExtensionAsk,
  type Settled,
  type Split,
  type Tally,
  type Weights,
  type WindowState,
} from "./audition";

export type DiamondsAction =
  | "start"
  /** Confirming a withdrawal, which now costs six months. */
  | "quit"
  /** Round 0's ballot, which is two buttons rather than a form. */
  | "verdict"
  /** Opens the ballot form for Rounds 1 and 2, and takes it back. */
  | "score"
  | "score-save"
  /** Opens the Round 0 document, and the per-round note. */
  | "doc"
  | "note"
  | "doc-save"
  | "note-save"
  /** The ephemeral read-back that the one irreversible button lives on. */
  | "preview"
  | "send"
  /** Round 1 didn't move: carry them into Round 2 as practice instead. */
  | "carry"
  /** The dancer's own four, so `register` is the only thing anyone types. */
  | "submit"
  | "submit-save"
  | "plan"
  | "plan-save"
  | "leave"
  /** A dancer taking the practice offer after a Round 0 fail. */
  | "practice"
  /** Asking for more days, and the two answers to it. */
  | "ask"
  | "ask-save"
  | "ask-grant"
  | "ask-deny"
  | "ask-deny-save";

const ACTIONS: DiamondsAction[] = [
  "start",
  "quit",
  "verdict",
  "score",
  "score-save",
  "doc",
  "note",
  "doc-save",
  "note-save",
  "preview",
  "send",
  "carry",
  "submit",
  "submit-save",
  "plan",
  "plan-save",
  "leave",
  "practice",
  "ask",
  "ask-save",
  "ask-grant",
  "ask-deny",
  "ask-deny-save",
];
const PREFIX = "dia";
const ARG = /^[0-9a-zA-Z:_-]{1,64}$/;

/**
 * `dia|<action>|<arg>`, where arg is a round for the start button, a dancer id
 * for everything a director presses, and `<dancer>:<verdict>` for Round 0's
 * two.
 *
 * The start button is notably *not* keyed by the person. The clicker's own id
 * comes off the interaction, so it can only ever start the window of whoever
 * pressed it — which is what makes it safe to put the same panel in a DM, an
 * ephemeral reply and a nudge.
 *
 * The director's buttons are the other way round: they name the dancer, because
 * they hang on a card in a channel rather than in anybody's DMs, and the
 * clicker is whichever of the two sat down to review. Which is also why every
 * one of them re-checks that the clicker is a director — a button in a channel
 * is pressable by anyone who can see the channel.
 *
 * **No round in the arg.** The round is derived from the record at click time,
 * because a button lives as long as the message does: a card from last week
 * with `:1` baked into it would take a Round 1 ballot on a Round 2 video.
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

/**
 * Named after the year it opened, now that nothing closes.
 *
 * Still a name rather than nothing: "Diamonds 2026" is what people will call
 * it, and a panel headed by a round number alone reads like a form.
 */
export function cycleName(timeline: DiamondsTimeline): string {
  return `Diamonds ${new Date(timeline.opensAt).getUTCFullYear()}`;
}

/** Everything the panels need to know beyond the record itself. */
export interface PanelContext {
  timeline: DiamondsTimeline;
  windowDays: number;
  reviewMinDays: number;
  reviewMaxDays: number;
  /** Only the roster uses this, and only to say what's stuck on one ballot. */
  minScores: number;
  retryMonths: number;
  /** Round 1's panel quotes the number they have to reach, so it needs both. */
  bar: number;
  requiredSteps: number;
  /** Days for the whole run, counted from registration. */
  runDays: number;
}

/**
 * A pass: the news, the document, and the one button that matters.
 *
 * Everything a dancer is owed arrives at once — the verdict and the reasons,
 * because both are theirs the moment they're written.
 *
 * **One button, and it's the real one.** Two earlier versions each put a step
 * in front of the piece: one held the document behind a click, the other held
 * the *round* behind a click that revealed nothing. The second needed a
 * paragraph explaining that it was safe to press, which is the tell — a button
 * whose only job is to prove it does nothing is a button that shouldn't exist.
 *
 * So this is the start button, on the message that tells them they passed. It
 * reveals the piece and starts the clock together, exactly as it does from the
 * panel, and `startWarning` says so above it. Nothing is lost by collapsing the
 * two: the dancer still presses when they're ready, and "when they're ready"
 * was always the only thing the extra step was protecting.
 *
 * Only sent once the Round 1 piece is up, which is what makes the button
 * pressable at all.
 *
 * Keyed to the round rather than to the person: the clicker's own id comes off
 * the interaction, so the same message is safe anywhere.
 */
export function feedbackArrived(document: string, windowDays: number): MessagePayload {
  return {
    content:
      `💎 **Round 0: you're through to Round 1.** Nicely done.\n\n` +
      `${document}\n\n` +
      `**Your Round 1 piece is ready when you are.**\n` +
      `${startWarning(ROUND_REVEAL[1], windowDays)}\n\n` +
      `No hurry: read the above properly first, and press it when you've got ` +
      `${windowDays} days you're happy to spend.`,
    components: row(BUTTON.start(1)),
  };
}

/**
 * A fail: everything at once, and a way to carry on anyway.
 *
 * Nothing is held back here, and that's the asymmetry. A pass holds the
 * document because opening it *does* something — it starts Round 1, which is
 * the dancer's to time. A fail opens nothing, so a button in front of the
 * reasons would be a hoop for its own sake, and the reasons are the only part
 * of a fail worth having.
 *
 * The practice offer is on this message rather than on a director's card
 * because it is the dancer's call, and this is the moment they have the
 * information to make it.
 */
export function feedbackRefused(document: string, windowDays: number): MessagePayload {
  return {
    content:
      `**Round 0: we're not taking this one through to Round 1.** That's our ` +
      `call on what we saw, not a verdict on you as a dancer.\n\n` +
      `${document}\n\n` +
      `**If you'd like to dance the rest of it anyway, you can.** Rounds 1 and 2 ` +
      `as practice: the same pieces, the same ${windowDays}-day windows, the same ` +
      `written feedback from both of us — and no verdict at the end, because this ` +
      `one is already decided. It costs you nothing and it doesn't change this ` +
      `result either way.`,
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SECONDARY,
            label: "Dance the rest as practice",
            custom_id: diamondsCustomId("practice", "me"),
          },
        ],
      },
    ],
  };
}

/**
 * Says so, on every panel, whenever this round isn't being judged.
 *
 * On the head rather than buried in the body because it changes what every
 * other line on the panel means — a window, a score and a piece all read
 * differently when nothing is riding on them, and someone who forgot they asked
 * for practice should not have to infer it from the absence of a verdict.
 */
function practiceTag(record: DiamondsRecord, round: Round): string {
  if (!isPractice(record, round)) return "";
  return record.practiceFrom === 0 ? " · practice" : " · practice from here";
}

/**
 * The dancer's own buttons, by what they can actually do right now.
 *
 * Keyed to nobody — the clicker's id comes off the interaction, so the same
 * panel is safe in a DM, in an ephemeral reply and on a nudge. The commands all
 * still work; these exist because `/diamonds submit link:<url>` is a lot to
 * type on a phone in a studio, and because a panel that tells you to run a
 * command is a panel that could have just done the thing.
 *
 * Never the irreversible one. Withdrawing costs six months, so its button only
 * opens the warning — the confirm lives there, where the words are.
 */
const BUTTON = {
  start: (round: Round) => ({
    type: ComponentType.BUTTON,
    style: ButtonStyle.PRIMARY,
    label: "Start time now",
    custom_id: diamondsCustomId("start", String(round)),
  }),
  submit: (first: boolean) => ({
    type: ComponentType.BUTTON,
    style: first ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY,
    label: first ? "Submit my video" : "Replace it",
    custom_id: diamondsCustomId("submit", "me"),
  }),
  cover: (first: boolean) => ({
    type: ComponentType.BUTTON,
    style: first ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY,
    label: first ? "Submit my cover" : "Replace it",
    custom_id: diamondsCustomId("submit", "me"),
  }),
  plan: (set: boolean) => ({
    type: ComponentType.BUTTON,
    style: ButtonStyle.SECONDARY,
    label: set ? "Change my day" : "Say when I'll start",
    custom_id: diamondsCustomId("plan", "me"),
  }),
  leave: {
    type: ComponentType.BUTTON,
    style: ButtonStyle.SECONDARY,
    label: "Withdraw",
    custom_id: diamondsCustomId("leave", "me"),
  },
  ask: {
    type: ComponentType.BUTTON,
    style: ButtonStyle.SECONDARY,
    label: "Ask for more time",
    custom_id: diamondsCustomId("ask", "me"),
  },
} as const;

const row = (...buttons: unknown[]) => [
  { type: ComponentType.ACTION_ROW, components: buttons },
];

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
  const head = `**Round 0 · ${cycleName(ctx.timeline)}${practiceTag(record, 0)}**`;

  if (record.cohort === "returning") {
    // Nothing is assessed, so there is nothing for them to do but be on the
    // list. Said plainly, because "you're registered and that's all" reads like
    // a missing instruction otherwise.
    const doc = record.document?.deliveredAt
      ? `Your feedback went out ${day(record.document.deliveredAt)}, so Round 1 ` +
        `is open — the start button is on that message.`
      : `The directors are writing up your season and deciding whether to take ` +
        `you through. It arrives as one message, with your Round 1 piece behind ` +
        `the button on it.`;
    // A renewal and a first-time returning Diamond are in the same state but
    // not in the same conversation: one of them is being told how this works
    // and the other already knows.
    const opening = record.history?.length
      ? `${head}\n✅ **Your renewal is in.** Round 0 is the application and our ` +
        `feedback on where you are now — no video, nothing to submit.`
      : `${head}\n✅ **You're registered.** Round 0 asks nothing of returning ` +
        `Diamonds — no video, nothing to submit.`;
    return { content: `${opening}\n${doc}` };
  }

  if (entry.submittedAt) {
    return {
      content:
        `${head}\n✅ **Submitted** ${when(entry.submittedAt)}.\n${entry.submissionUrl ?? ""}\n\n` +
        `We'll come back to you within **${ctx.reviewMinDays}–${ctx.reviewMaxDays} days** with ` +
        `written feedback and whether you're through to Round 1 — one message, ` +
        `both things. You can still replace this until we do: the last one in is ` +
        `the one we watch.`,
      components: row(BUTTON.cover(false)),
    };
  }

  return {
    content:
      // Only reachable for somebody a director added — registering is sending
      // the cover, so a dancer can't arrive here under their own steam. Said
      // plainly, because the likeliest reader is wondering why they're on a
      // list they never joined.
      `${head}\n📼 **You're on the list, and we need a cover from you.** A ` +
      `director put you on rather than you registering, so this may be news.\n\n` +
      `Your own choice of piece, and an existing one from the last six months is ` +
      `fine — you don't have to film anything new. It's judged as a yes or a no, ` +
      `not scored: does this belong in the process. Either way you get written ` +
      `feedback.\n` +
      `The button below, or \`/diamonds submit link:<url>\`.\n\n` +
      runLine(record, ctx, now) +
      planLine(entry),
    components: row(BUTTON.cover(true), BUTTON.plan(!!entry.plannedStartAt)),
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
/**
 * Their own deadline, which is the only one left.
 *
 * Said on every panel where the next move is theirs, because it is the one
 * thing in a rolling process that can run out without anybody doing anything —
 * and a clock nobody mentions is a clock people find out about afterwards.
 */
function runLine(record: DiamondsRecord, ctx: PanelContext, now: Date): string {
  const ends = runEndsAt(record, ctx.runDays);
  if (!ends) return "";
  const left = runDaysLeft(record, ctx.runDays, now) ?? 0;
  const needed = ctx.reviewMaxDays * 2 + ctx.windowDays * 2;

  if (left <= 0) {
    return (
      `\n\n⌛ **Your ${ctx.runDays} days ran out ${day(ends)}.** Talk to a director — ` +
      `they can put you back on the list with a fresh ${ctx.runDays} days.`
    );
  }
  return (
    `\n\n⏳ **All three rounds by ${day(ends)}** — ${ctx.runDays} days from when you ` +
    `registered, and **${left}** left. The whole thing takes about ${needed} days ` +
    `of actual process, so there's room; if you need more, ask a director before ` +
    `the date rather than after.`
  );
}

/**
 * Their open ask, said on the panel so it doesn't vanish into a DM.
 *
 * The gap between asking and being answered is the only stretch in this process
 * where a dancer is waiting on a human with a deadline still running, and a
 * panel that showed the old deadline with no mention of the question would read
 * as though nobody had got it.
 */
function askLine(record: DiamondsRecord): string {
  const ask = record.request;
  if (!ask) return "";
  if (ask.granted === undefined) {
    return (
      `\n\n⏳ **You asked for ${ask.days} more day${ask.days === 1 ? "" : "s"}** ` +
      `${when(ask.at)} — the directors have it and nobody has answered yet. The ` +
      `deadline above is still the one that counts until they do.`
    );
  }
  if (ask.granted) return "";
  return (
    `\n\n🚫 **Your request for more days was declined**, so the deadline above ` +
    `stands.` + (ask.note ? `\n> ${ask.note.split("\n").join("\n> ")}` : "")
  );
}

function planLine(entry: RoundRecord): string {
  if (entry.plannedStartAt) {
    return (
      `\n\n📌 **You said around ${entry.plannedStartAt}.** Move it whenever with ` +
      `\`/diamonds plan date:YYYY-MM-DD\` — it was only ever an estimate, and ` +
      `nothing happens if it slips.`
    );
  }
  return (
    `\n\n📌 **Pick a day you'll start and tell us** — the button below, or ` +
    `\`/diamonds plan date:YYYY-MM-DD\`. Nothing is held against it and nothing ` +
    `chases you about it; it's so the directors can see when to expect you, and ` +
    `so you've named a day rather than meaning to name one.`
  );
}

function targetLine(record: DiamondsRecord, round: Round, ctx: PanelContext): string {
  if (round !== 1 || !record.target) return "";
  // The number they have to reach, said out loud. The rule behind it — half the
  // distance to the bar, capped at the bar — is not something anyone should have
  // to reconstruct from a doc to know what this round is asking of them.
  const before =
    record.targetBefore === undefined
      ? ""
      : ` We have it at **${record.targetBefore.toFixed(1)}/10** as of the day ` +
        `this piece went up, and that number is now fixed — it was set before ` +
        `anyone had seen what you'd do with it, which is the only way it's worth ` +
        `anything.\n**To advance, we need to read it at ` +
        `${targetToBeat(record.targetBefore, ctx.bar, ctx.requiredSteps).toFixed(2)}/10 ` +
        `or better.**` +
        (record.targetBefore >= ctx.bar
          ? ` It's already at the bar, so the ask is that it's still there.`
          : ` That's half the distance to the bar — the further off it is, the ` +
            `more of that distance we want to see closed.`);
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
  const head = `**Round ${round} · ${cycleName(ctx.timeline)}${practiceTag(record, round)}**`;
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
      // Still replaceable while the window is open: the last one in is the one
      // we watch, and someone who finds a better take at 1am shouldn't have to
      // ask anybody.
      components:
        windowState(entry, ctx.windowDays, now) === "submitted" &&
        windowClosesAt(entry, ctx.windowDays) &&
        new Date(windowClosesAt(entry, ctx.windowDays)!).getTime() > now.getTime()
          ? row(BUTTON.submit(false))
          : undefined,
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
        `Submit before your window closes — the button, or ` +
        `\`/diamonds submit link:<url>\`.` +
        targetLine(record, round, ctx) +
        askLine(record),
      // Asking sits next to submitting rather than somewhere else, because the
      // moment someone realises they need more time is the moment they are
      // looking at this panel wondering whether they can finish.
      components: requestPending(record)
        ? row(BUTTON.submit(true))
        : row(BUTTON.submit(true), BUTTON.ask),
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

  const allowed = canStartWindow(record, round, ctx.windowDays, now);
  if (!allowed.ok) return { content: `${head}\n⚠️ ${allowed.reason}` };

  return {
    content:
      `${head}\n🎬 **Your piece is ready.** Nobody needs to be here for this — ` +
      `start whenever you're ready to give it ${ctx.windowDays} days.\n\n` +
      `${startWarning(ROUND_REVEAL[round], ctx.windowDays)}\n\n` +
      `**No deadline on starting the window itself** — the piece keeps until you ` +
      `want it.` +
      runLine(record, ctx, now) +
      targetLine(record, round, ctx) +
      planLine(entry),
    components: row(BUTTON.start(round), BUTTON.plan(!!entry.plannedStartAt)),
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
  if (record.enforcedAt) {
    lines.push(`Membership · renews by ${day(record.enforcedAt)}`);
  }
  // Only once there is one, so a first-timer is never told they are on their
  // first — which reads as a count of something they are expected to repeat.
  const number = auditionNumber(record);
  if (number > 1) lines.push(`This is audition ${number} · the earlier ones are on file`);

  // Said here rather than only at the door, so nobody has to try registering to
  // find out when they can.
  const waiting = retryBlocked(record, ctx.retryMonths, now);
  if (waiting) lines.push(`Next audition · you can register again from ${day(waiting)}`);

  // Never here. An ask only ever moves an open window, and the panel for the
  // round whose window it is already carries the button — offering it a second
  // time from the status page would be offering it from a screen that can't say
  // which window it means.
  const offersAsk = false;

  return {
    content:
      `${panel.content}\n\n**Where everything stands**\n${lines
        .map((one) => `· ${one}`)
        .join("\n")}\n\n` +
      `Each window is ${ctx.windowDays} days and we review within ` +
      `${ctx.reviewMinDays}–${ctx.reviewMaxDays}, so all three rounds take about ` +
      `${ctx.reviewMaxDays * 2 + ctx.windowDays * 2} days end to end at worst — ` +
      `whenever you choose to spend them.`,
    // Withdrawing lives here rather than on a round panel, because this is the
    // panel about *them* rather than about a round — and because the one button
    // that costs six months should not sit next to the one that submits a video.
    //
    // Asking for time sits beside it, and the pairing is deliberate: these are
    // the two things to do when a deadline is a problem, and one of them is far
    // better than the other.
    components: [
      ...((panel.components as unknown[]) ?? []),
      ...(activeRound(record, now).ok
        ? row(...(offersAsk ? [BUTTON.ask] : []), BUTTON.leave)
        : []),
    ],
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
    `**${cycleName(ctx.timeline)}** — ${live.length} registered`,
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
    [
      "diamonds_start_heads_up_days",
      "heads-up",
      `${policy.headsUpDays} days sitting on a piece, or registered with no cover`,
    ],
    [
      "diamonds_start_nudge_days",
      "unread nudge",
      `${policy.nudgeDays} days of unopened feedback`,
    ],
  ] as const;

  const lines = [
    `**${cycleName(readout.timeline)} — setup**`,
    "",
    `**Timeline** (${readout.timeZone})`,
    `${mark(readout.dateSources.opensAt ?? "default")} opens — ${day(readout.timeline.opensAt)}`,
    `· nothing closes — membership is enforced per person, Jan 1 / Jul 1`,
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
          ? `Sent — Round 1 is open for them, start button and all.`
          : record.document
            ? roundOf(record, 1).assignedPiece
              ? `Their feedback is written and goes out with this. Nothing has ` +
                `reached them yet.`
              : `Their feedback is written and **waiting on Round 1's piece** — ` +
                `the two go out as one message, so \`/diamonds assign\` sends it.`
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

/* -------------------------------------------------------------------------- */
/* The review card                                                             */
/* -------------------------------------------------------------------------- */

export interface ReviewOptions {
  minScores: number;
  weights: Weights;
  bar: number;
  floor: number;
  /** Where the scoring commands work, since they don't work where this is posted. */
  commandChannel: string;
}

/**
 * One submitted video, in #audition-review, for the two of you to watch.
 *
 * The channel is where applicant and trainee videos already land, so a director
 * sitting down to review has one place to be rather than three. It is also a
 * channel in the community guild, while `/diamonds` is registered to the dance
 * one — so the card carries buttons rather than naming commands, because a
 * component interaction arrives from wherever the message is and a slash
 * command does not.
 *
 * **Nothing sealed appears here.** A count of ballots, never a ballot: the card
 * hangs in a channel both directors read, so anything it showed before the
 * round settled would anchor the second of them exactly as a visible tally in
 * the reply would. The scores and the verdict go on only once the round is
 * settled, at which point the seal has done its work.
 */
/**
 * A dancer's ask for more days, as a thing to answer in #audition-review.
 *
 * Its own message rather than a row on the review card, because the review card
 * is posted when a round is *submitted* — and somebody who needs more time
 * hasn't submitted, so for most asks there is no card to hang this on. The
 * trainee version can live on the card because that card exists for the whole
 * audition; this one has to bring its own.
 *
 * Two buttons and no scoring, which is the rule the trainee card states: an
 * extension request is the only thing on a directors' screen with somebody
 * waiting on an answer, and leaving anything else pressable next to it invites
 * answering a question nobody asked.
 *
 * Once answered it keeps the words and drops the buttons. The outcome is the
 * audit trail — "who gave them another week, and why" has to survive the
 * decision.
 */
export function askCard(
  record: DiamondsRecord,
  ask: ExtensionAsk,
  windowDays: number,
): MessagePayload {
  const who = record.displayName ?? `<@${record.discordId}>`;
  const what = `their Round ${ask.round} window (${windowDays} days)`;
  const quoted = ask.reason
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  if (ask.granted === undefined) {
    return {
      content:
        `⏳ **${who} is asking for ${ask.days} more day${ask.days === 1 ? "" : "s"}** ` +
        `on ${what}.\n${quoted}\n\n` +
        `Their deadline is still running while this sits here, so it's worth ` +
        `answering today either way. A denial needs a reason — they'll be told ` +
        `what you write.`,
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.BUTTON,
              style: ButtonStyle.SUCCESS,
              label: `Grant ${ask.days} day${ask.days === 1 ? "" : "s"}`,
              custom_id: diamondsCustomId("ask-grant", record.discordId),
            },
            {
              type: ComponentType.BUTTON,
              style: ButtonStyle.SECONDARY,
              label: "Deny",
              custom_id: diamondsCustomId("ask-deny", record.discordId),
            },
          ],
        },
      ],
    };
  }

  return {
    content:
      `${ask.granted ? "✅" : "🚫"} **${who} asked for ${ask.days} more ` +
      `day${ask.days === 1 ? "" : "s"}** on ${what}.\n${quoted}\n\n` +
      `${ask.granted ? "Granted" : "Denied"} by <@${ask.by ?? "?"}>` +
      `${ask.answeredAt ? ` ${when(ask.answeredAt)}` : ""}.` +
      (ask.note ? `\n> ${ask.note.split("\n").join("\n> ")}` : ""),
    components: [],
  };
}

export function reviewCard(
  record: DiamondsRecord,
  round: Round,
  counted: Tally,
  settled: Settled | undefined,
  opts: ReviewOptions,
): MessagePayload {
  const entry = roundOf(record, round);
  const sent = !!entry.resultSentAt;

  const fields: { name: string; value: string; inline?: boolean }[] = [
    {
      name: "Video",
      value: entry.submissionUrl ?? "— nothing submitted",
      inline: false,
    },
    {
      name: "Submitted",
      value: entry.submittedAt ? day(entry.submittedAt) : "—",
      inline: true,
    },
    {
      name: "Cohort",
      value: record.cohort === "returning" ? "Returning Diamond" : "Newcomer",
      inline: true,
    },
  ];

  // Round 1's two fixed facts, on the card because the round is unreadable
  // without them: a video of someone dancing means nothing until you know which
  // one thing you are watching and what it looked like before.
  if (round === 1) {
    fields.push(
      { name: "What it tests", value: record.target ?? "— not set", inline: false },
      {
        name: "Where we had it",
        value:
          record.targetBefore === undefined
            ? "— not set"
            : `**${record.targetBefore.toFixed(2)}/10**, fixed ` +
              `${record.targetFixedAt ? day(record.targetFixedAt) : "at assignment"}`,
        inline: true,
      },
    );
  }

  const blocks: string[] = [reviewAsk(record, round, counted, opts)];
  if (settled) blocks.push(reviewOutcome(record, round, counted, settled, opts));
  if (sent) blocks.push(`📨 Result sent ${day(entry.resultSentAt!)}.`);

  return {
    embeds: [
      {
        title: `${record.displayName || `Dancer ${record.discordId}`} · Round ${round}`,
        description: blocks.join("\n\n").slice(0, 4000),
        fields,
        footer: {
          text: `${counted.count} of ${opts.minScores} ballots · ${
            sent ? "result sent" : settled ? "settled, not sent" : "open"
          }`,
        },
      },
    ],
    allowed_mentions: { parse: [] },
    // Explicitly 0 for the reason the trainee card gives: on a card that IS an
    // embed, SUPPRESS_EMBEDS hides the card, and an edit only clears a flag if
    // the edit says so.
    flags: 0,
    components: reviewRows(record, round, settled, sent),
  };
}

/**
 * What the two of them can do about this video without leaving the channel.
 *
 * The whole point of putting them here: `/diamonds` is registered to the dance
 * guild and this card hangs in the community one, so a command named on the
 * card is a command you have to go somewhere else to run. A button isn't —
 * component interactions arrive from wherever the message is.
 *
 * **A sent card has no buttons at all.** Everything below is either a ballot on
 * a round that's already closed or a second send of something that cannot be
 * unsent, so the row comes off rather than sitting there refusing.
 */
function reviewRows(
  record: DiamondsRecord,
  round: Round,
  settled: Settled | undefined,
  sent: boolean,
): unknown[] {
  if (sent) return [];
  const id = record.discordId;

  // Round 0 is a decision with two values, which is what a pair of buttons is.
  // No modal, no ladder, nothing to type.
  const buttons: unknown[] =
    round === 0
      ? [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SUCCESS,
            label: "Pass",
            custom_id: diamondsCustomId("verdict", `${id}:pass`),
          },
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.DANGER,
            label: "Fail",
            custom_id: diamondsCustomId("verdict", `${id}:fail`),
          },
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SECONDARY,
            label: record.document ? "Rewrite feedback" : "Write feedback",
            custom_id: diamondsCustomId("doc", id),
          },
        ]
      : [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.PRIMARY,
            label: "Score",
            custom_id: diamondsCustomId("score", id),
          },
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SECONDARY,
            label: "Note",
            custom_id: diamondsCustomId("note", id),
          },
        ];

  // Deliberately a read-back and not a send. The result is the one thing in the
  // process that can't be undone, so the button that does it belongs on an
  // ephemeral preview of the exact words — never one click away on a card
  // sitting in a channel.
  if (round !== 0 && settled) {
    buttons.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.SUCCESS,
      label: "Read back & send",
      custom_id: diamondsCustomId("preview", id),
    });
  }

  // The branch. A Round 1 that didn't move is a fail, and this is the other
  // thing you can do about it: carry them into Round 2 with nothing at stake.
  //
  // Only here, and only on a fail. It's offered at the moment the decision is
  // actually in front of someone, rather than as a policy decided in advance
  // about a dancer nobody has watched yet — and it changes the round that
  // hasn't happened, which is why it can't be a second verdict on this one.
  if (round === 1 && settled?.outcome === "failed" && !anyPractice(record)) {
    buttons.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.SECONDARY,
      label: "Carry on as practice",
      custom_id: diamondsCustomId("carry", id),
    });
  }

  return [{ type: ComponentType.ACTION_ROW, components: buttons }];
}

/** What the two of them still owe this video. */
function reviewAsk(
  record: DiamondsRecord,
  round: Round,
  counted: Tally,
  opts: ReviewOptions,
): string {
  if (roundOf(record, round).resultSentAt) return `Done — nothing owed on this one.`;

  // Practice still wants both reads — they're what the feedback is built from —
  // but it's worth saying out loud that there's no decision at the end of them,
  // because the card otherwise looks exactly like one that needs deciding.
  if (isPractice(record, round)) {
    const outstanding = Math.max(0, opts.minScores - counted.count);
    return outstanding === 0
      ? `**Practice — nothing to decide.** Both reads in; write the feedback and send it.`
      : `**Practice — nothing to decide.** ${counted.count} of ${opts.minScores} ` +
          `reads in. Score it anyway: the numbers are what the feedback is built from.`;
  }

  const outstanding = Math.max(0, opts.minScores - counted.count);
  const ballots =
    outstanding === 0
      ? `All ${counted.count} ballots in.`
      : `${counted.count} of ${opts.minScores} ballots in — ${outstanding} to come. ` +
        `Nobody sees anybody else's until they are.`;
  // The commands still work and still do exactly this. Named as the fallback
  // rather than the route, because a button that stops working at 11pm is worth
  // a line of text.
  const fallback = `\`/diamonds score\` in #${opts.commandChannel} does the same.`;

  if (round === 0) {
    const doc = record.document
      ? `Feedback written.`
      : `**Feedback not written yet** — *Write feedback* below. Round 0's result ` +
        `**is** that document, so it sends itself once it exists and you've both ` +
        `called it.`;
    return (
      `**Pass or fail**, no numbers — the two buttons below.\n` +
      `${ballots} ${fallback}\n${doc}`
    );
  }

  if (round === 1) {
    return (
      `**Score the one named thing**, 0–10 as it is now — *Score* below.\n` +
      `${ballots} ${fallback}`
    );
  }

  return `**All four dimensions**, 0–10 — *Score* below.\n${ballots} ${fallback}`;
}

/** What the ballots came to, once there is no seal left to break. */
function reviewOutcome(
  record: DiamondsRecord,
  round: Round,
  counted: Tally,
  settled: Settled,
  opts: ReviewOptions,
): string {
  if (round === 0) {
    return settled.outcome === "passed" ? `🎉 **Through to Round 1.**` : `🚫 **Not through.**`;
  }

  if (round === 1 && settled.advancement) {
    const { before, after, steps } = settled.advancement;
    return (
      `**${record.target ?? "the target"}:** ${before.toFixed(2)} → ` +
      `${after.toFixed(2)} (${steps.toFixed(1)} anchor steps)
` +
      (settled.outcome === "advanced"
        ? `🎉 **Advances.**`
        : `🚫 **Doesn't advance** — no real movement on the thing we named.`)
    );
  }

  if (round === 2 && counted.scores) {
    return (
      `${scoreLine(counted.scores, opts.weights)}
${overallBand(counted.scores, opts.bar)}
` +
      (settled.outcome === "passed"
        ? `🎉 **Passes** — clears ${opts.bar} with nothing below ${opts.floor}.`
        : `🚫 **Doesn't pass** against ${opts.bar} / floor ${opts.floor}.`)
    );
  }

  return `Settled.`;
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

  // Practice says what we saw and stops. No verdict, because there wasn't one —
  // which is the whole of what a practice dancer asked for, and the one thing
  // this message must not quietly supply anyway.
  if (settled.outcome === "practice") {
    const scored = counted.scores
      ? `\n\n${DIMENSIONS.map((one) => `· ${DIMENSION_LABEL[one]} — **${counted.scores![one].toFixed(1)}**`).join("\n")}`
      : counted.targetScore !== undefined
        ? `\n\n**${record.target ?? "What we were watching"}:** ` +
          `**${counted.targetScore.toFixed(1)}**` +
          (record.targetBefore !== undefined
            ? ` now, against ${record.targetBefore.toFixed(1)} before.`
            : ".")
        : "";
    return (
      `**${name} — Round ${round}, practice**\n\n` +
      `📝 **Here's what we saw.** This one was practice, so there's no pass or ` +
      `fail in it and nothing rides on the numbers — they're there because a ` +
      `read you can't see isn't feedback.${scored}\n\n` +
      (round === 2
        ? `That's the end of the run. Nothing is recorded against you, and you ` +
          `can audition for real whenever you want to.`
        : `Your next piece will arrive here the same way.`) +
      notes
    );
  }

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
      : record.practiceFrom === 2
        ? // Carried on. The fail is still said plainly — softening it here is
          // what would make the offer feel like a consolation prize.
          `**${name} — Round 1**\n\n🚫 **That didn't move enough to carry you ` +
            `into Round 2 for real.**${delta}\n\n` +
            `**We'd like you to do Round 2 anyway, as practice.** Same piece as ` +
            `everyone, same ${ctx.windowDays} days, same written feedback — and ` +
            `no pass or fail at the end of it, because this run is already ` +
            `decided. Nothing is recorded against you and nothing stops you ` +
            `auditioning again.\n\n` +
            `Your piece will arrive here. If you'd rather stop, that's completely ` +
            `fine — tell a director.` + notes
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

  // The renewal date is said here, once, at the only moment it is unambiguously
  // good news. Saying it for the first time sixty days before it expires makes
  // it an eviction notice; saying it now makes it the shape of the thing they
  // just joined.
  const membership = record.enforcedAt
    ? `\n\n**Your membership runs to ${day(record.enforcedAt)}.** Diamonds is ` +
      `re-auditioned rather than permanent — go again before then and it renews, ` +
      `and going early in the half is worth a longer next term. We'll remind you ` +
      `well ahead; nothing to think about for months.`
    : "";

  return settled.outcome === "passed"
    ? `**${name} — Round 2**\n\n🎉 **You've passed.** Welcome to Diamonds.${detail}\n\n` +
        `You cleared ${policy.bar} with nothing below ${policy.floor}. A director ` +
        `will be in touch about what happens next.${membership}` + notes
    : `**${name} — Round 2**\n\n🚫 **Not this cycle.**${detail}\n\n` +
        `The bar was ${policy.bar} weighted, with nothing below ${policy.floor} in ` +
        `any one area. Those are your actual numbers, not a softened version — ` +
        `you're welcome to them and welcome to ask us about any of them.\n\n` +
        `Getting this far is not nothing, and there'll be another audition.` + notes;
}
