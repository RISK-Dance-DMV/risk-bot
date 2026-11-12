import { describe, expect, it } from "vitest";
import {
  ANCHOR_STEP,
  advancesRound1,
  targetToBeat,
  activeRound,
  ballotComplete,
  ballotSplits,
  canStartWindow,
  roundToScore,
  settleRound,
  tally,
  feedbackReady,
  canSubmit,
  DIMENSIONS,
  meanScore,
  needsReminder,
  notableCount,
  notYetStarted,
  pieceReady,
  round2Outcome,
  ROUND_REVEAL,
  startWarning,
  visiblePiece,
  overallBand,
  passesFinal,
  weightedScore,
  windowClosesAt,
  windowState,
  awaitingDelivery,
  DEFAULT_WEIGHTS,
  fixTarget,
  validateDocument,
  type DiamondsRecord,
  type Round,
  type RoundRecord,
  type Scores,
  type Verdict,
  parseScore,
  daysUntil,
  enforcementFor,
  noticeDue,
  renewalUnderway,
  auditionFinished,
  auditionNumber,
  reAudition,
  retryBlocked,
  retryBlockedUntil,
} from "../src/diamonds/audition";

/** The settled policy numbers, from DIAMONDS-RUBRIC.md. Passed, never imported. */
const BAR = 7.5;
const FLOOR = 6;
const WINDOW = 3;
/** Everything shuts at one moment now, in every round. */
const CLOSES = "2026-12-13T00:00:00.000Z";
/** Everything three rounds cost, at the slow end of the review range. */
const REVIEW_MAX = 5;

/** A whole record carrying one round-2 entry, which is what the checks take. */
const withRound2 = (entry: RoundRecord): DiamondsRecord => ({
  discordId: "1",
  cohort: "new",
  rounds: { 2: entry },
});
const STEPS = 1;

const scores = (over: Partial<Scores> = {}): Scores => ({
  technicality: 7.5,
  execution: 7.5,
  performance: 7.5,
  musicality: 7.5,
  ...over,
});

const entry = (over: Partial<RoundRecord> = {}): RoundRecord => ({
  assignedPiece: "https://youtu.be/assigned",
  ...over,
});

const at = (iso: string) => new Date(iso);

describe("the window", () => {
  it("has no deadline until it is started", () => {
    const waiting = entry();
    expect(windowState(waiting, WINDOW, at("2026-11-30T10:00:00.000Z"))).toBe(
      "not-started",
    );
    expect(windowClosesAt(waiting, WINDOW)).toBeUndefined();
  });

  it("closes three days after it opens", () => {
    const open = entry({ windowOpenedAt: "2026-12-01T09:00:00.000Z" });
    expect(windowClosesAt(open, WINDOW)).toBe("2026-12-04T09:00:00.000Z");
  });

  it("adds an extension on top, and extensions can be partial", () => {
    const extended = entry({
      windowOpenedAt: "2026-12-01T09:00:00.000Z",
      extension: { days: 1, reason: "flu", by: "111", at: "2026-12-03T09:00:00.000Z" },
    });
    expect(windowClosesAt(extended, WINDOW)).toBe("2026-12-05T09:00:00.000Z");
  });

  it("lapses once it runs out with nothing submitted", () => {
    const open = entry({ windowOpenedAt: "2026-12-01T09:00:00.000Z" });
    expect(windowState(open, WINDOW, at("2026-12-04T08:59:00.000Z"))).toBe("open");
    expect(windowState(open, WINDOW, at("2026-12-04T09:00:00.000Z"))).toBe("lapsed");
  });
});

describe("what someone can do without a director present", () => {
  it("refuses to hand over a piece that isn't assigned, and says it's not their fault", () => {
    const check = pieceReady({});
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("It'll arrive here when it is");
  });

  it("lets them start once a piece is up", () => {
    expect(
      canStartWindow(withRound2(entry()), 2, WINDOW, at("2026-11-23T10:00:00.000Z")),
    ).toEqual({ ok: true });
  });

  it("refuses a second window once one is open", () => {
    const check = canStartWindow(withRound2(entry({ windowOpenedAt: "2026-12-01T09:00:00.000Z" })), 2, WINDOW, at("2026-12-02T09:00:00.000Z"));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("already open");
  });

  it("only accepts a submission inside an open window", () => {
    const open = entry({ windowOpenedAt: "2026-12-01T09:00:00.000Z" });
    expect(canSubmit(open, WINDOW, at("2026-12-02T09:00:00.000Z"))).toEqual({ ok: true });
    expect(canSubmit(entry(), WINDOW, at("2026-12-02T09:00:00.000Z")).ok).toBe(false);
    expect(canSubmit(open, WINDOW, at("2026-12-09T09:00:00.000Z")).ok).toBe(false);
  });

  it("reminds once, a day out, and not after submitting", () => {
    const open = entry({ windowOpenedAt: "2026-12-01T09:00:00.000Z" });
    expect(needsReminder(open, WINDOW, at("2026-12-02T08:00:00.000Z"))).toBe(false);
    expect(needsReminder(open, WINDOW, at("2026-12-03T10:00:00.000Z"))).toBe(true);
    expect(
      needsReminder({ ...open, remindedAt: "2026-12-03T10:00:00.000Z" }, WINDOW, at("2026-12-03T11:00:00.000Z")),
    ).toBe(false);
    expect(
      needsReminder({ ...open, submittedAt: "2026-12-02T09:00:00.000Z" }, WINDOW, at("2026-12-03T10:00:00.000Z")),
    ).toBe(false);
  });
});

describe("the bar", () => {
  it("is the deck's own step size", () => {
    expect(ANCHOR_STEP).toBe(1.25);
  });

  it("weights technicality heaviest and musicality lightest", () => {
    // Strong technique, weak musicality beats the reverse, by design.
    const technical = scores({ technicality: 10, musicality: 5 });
    const musical = scores({ technicality: 5, musicality: 10 });
    expect(weightedScore(technical, DEFAULT_WEIGHTS)).toBeGreaterThan(
      weightedScore(musical, DEFAULT_WEIGHTS),
    );
    // Flat average can't tell them apart, which is the point of weighting.
    expect(meanScore(technical)).toBe(meanScore(musical));
  });

  it("normalises weights, so 4/3/2/1 means the same as 0.4/0.3/0.2/0.1", () => {
    const whole = { technicality: 4, execution: 3, performance: 2, musicality: 1 };
    expect(weightedScore(scores({ musicality: 5 }), whole)).toBeCloseTo(
      weightedScore(scores({ musicality: 5 }), DEFAULT_WEIGHTS),
    );
  });

  it("passes a score at the bar with nothing below the floor", () => {
    expect(passesFinal(scores(), BAR, FLOOR)).toBe(true);
    expect(
      passesFinal(scores({ technicality: 8.75, execution: 8.75, performance: 6.25, musicality: 6.25 }), BAR, FLOOR),
    ).toBe(true);
  });

  it("keeps the floor off the ladder's anchors, which is allowed", () => {
    // 6 sits between the deck's 5 and 6.25. Deliberate: "a hair under positive
    // trajectory" is a floor, and nothing requires it to be an anchor.
    const strong = { technicality: 10, execution: 10, performance: 10 };
    // Weighted 9.6 either way — only the floor separates these two.
    expect(passesFinal({ ...strong, musicality: 6 }, BAR, FLOOR)).toBe(true);
    expect(passesFinal({ ...strong, musicality: 5.9 }, BAR, FLOOR)).toBe(false);
  });

  it("refuses a zero in musicality even though weighting barely notices it", () => {
    // 0.4*10 + 0.3*10 + 0.2*10 + 0.1*0 = 9.0 — way past the bar, with a zero.
    const hollow = scores({
      technicality: 10,
      execution: 10,
      performance: 10,
      musicality: 0,
    });
    expect(weightedScore(hollow, DEFAULT_WEIGHTS)).toBeCloseTo(9);
    expect(passesFinal(hollow, BAR, FLOOR)).toBe(false);
  });

  it("refuses 10/10/5/5 even though it averages the bar", () => {
    const lopsided = scores({
      technicality: 10,
      execution: 10,
      performance: 5,
      musicality: 5,
    });
    expect(meanScore(lopsided)).toBe(BAR);
    expect(passesFinal(lopsided, BAR, FLOOR)).toBe(false);
  });

  it("derives the deck's holistic anchor by counting notables", () => {
    expect(notableCount(scores(), BAR)).toBe(4);
    expect(overallBand(scores(), BAR)).toBe("notable ability in multiple areas");
    expect(
      overallBand(scores({ performance: 6.25, musicality: 5 }), BAR),
    ).toBe("notable ability in a couple of areas");
    expect(
      overallBand(scores({ technicality: 6.25, execution: 6.25, performance: 6.25, musicality: 6.25 }), BAR),
    ).toBe("evidence of ability on a positive trajectory");
  });

});

describe("Round 1 is a delta, not a bar", () => {
  it("advances the example that climbed from nowhere", () => {
    const moved = advancesRound1(1.25, 6.25, BAR, STEPS);
    expect(moved.advanced).toBe(true);
    expect(moved.steps).toBe(4);
    expect(moved.because).toBe("improved");
  });

  // At the bar the ask is to still have it, so this reads as "already there"
  // rather than as an improvement. Nobody at 7.5 is being congratulated on
  // movement they didn't need to make.
  it("advances someone already at the bar who nudged up", () => {
    const held = advancesRound1(7.5, 8.75, BAR, STEPS);
    expect(held.advanced).toBe(true);
    expect(held.because).toBe("already-there");
  });

  /**
   * The curve, which is the whole rule: half the distance to the bar, floored
   * at one anchor step, capped at the bar.
   *
   * Written as a table because the two properties that matter are properties of
   * the whole shape rather than of any one row — the ask never rises as someone
   * gets better, and it never exceeds the bar.
   */
  it("asks more of a worse start, and never asks anyone to beat the bar", () => {
    const need = (before: number) => targetToBeat(before, BAR, STEPS);
    expect([1, 2, 3, 4, 5, 6, 7, 7.5, 8.75].map(need)).toEqual([
      4.25, // half of the 6.5 gap
      4.75,
      5.25,
      5.75,
      6.25,
      7.25, // the one-step floor takes over here
      7.5, // capped: the flat rule wanted 8.25, above the bar
      7.5, // at the bar, hold
      8.75,
    ]);

    // The ask, as an improvement, never goes up as the start gets better.
    const asks = [1, 2, 3, 4, 5, 6, 7, 7.5].map((b) => need(b) - b);
    for (let i = 1; i < asks.length; i += 1) {
      expect(asks[i]!).toBeLessThanOrEqual(asks[i - 1]!);
    }
  });

  /**
   * The cliff the flat rule had, which this is the fix for: at 7 it demanded
   * 8.25 — above the bar — while 7.5 only had to hold station, making just
   * under the bar the hardest place on the scale to start.
   */
  it("no longer makes just-under-the-bar the hardest place to be", () => {
    expect(advancesRound1(7, 7.5, BAR, STEPS).advanced).toBe(true);
    expect(advancesRound1(7, 7.4, BAR, STEPS).advanced).toBe(false);
    expect(targetToBeat(7, BAR, STEPS)).toBe(targetToBeat(7.5, BAR, STEPS));
  });

  /** And the number is reported, so a card can say what was asked. */
  it("reports what they had to reach", () => {
    expect(advancesRound1(3, 5.25, BAR, STEPS).needed).toBe(5.25);
    expect(advancesRound1(3, 4, BAR, STEPS)).toMatchObject({
      advanced: false,
      needed: 5.25,
      because: "no-movement",
    });
  });

  it("advances someone already strong who held station", () => {
    const steady = advancesRound1(8.75, 8.75, BAR, STEPS);
    expect(steady.advanced).toBe(true);
    expect(steady.steps).toBe(0);
    expect(steady.because).toBe("already-there");
  });

  it("does not advance a middling score that didn't move", () => {
    const stuck = advancesRound1(5, 5, BAR, STEPS);
    expect(stuck.advanced).toBe(false);
    expect(stuck.because).toBe("no-movement");
  });

  it("does not advance half a step", () => {
    expect(advancesRound1(5, 5.625, BAR, STEPS).advanced).toBe(false);
    expect(advancesRound1(5, 6.25, BAR, STEPS).advanced).toBe(true);
  });

  it("does not rescue someone above the bar who went backwards", () => {
    expect(advancesRound1(8.75, 7.5, BAR, STEPS).advanced).toBe(false);
  });

  it("is harsher when two steps are required", () => {
    expect(advancesRound1(5, 6.25, BAR, 2).advanced).toBe(false);
    expect(advancesRound1(5, 7.5, BAR, 2).advanced).toBe(true);
  });

  /** One anchor step is no longer enough from a long way out. */
  it("doesn't let one step carry a weak start", () => {
    expect(advancesRound1(2, 3.25, BAR, STEPS).advanced).toBe(false);
    expect(advancesRound1(2, 4.75, BAR, STEPS).advanced).toBe(true);
  });
});

describe("starting reveals the piece", () => {
  it("hides a Round 1 piece until the window opens", () => {
    const ready = entry();
    expect(visiblePiece(ready, "on-start")).toBeUndefined();
    expect(
      visiblePiece({ ...ready, windowOpenedAt: "2026-11-23T10:00:00.000Z" }, "on-start"),
    ).toBe("https://youtu.be/assigned");
  });

  it("hides Round 2's piece too, even though everyone dances the same one", () => {
    expect(ROUND_REVEAL[1]).toBe("on-start");
    expect(ROUND_REVEAL[2]).toBe("on-start");
    expect(visiblePiece(entry(), ROUND_REVEAL[2])).toBeUndefined();
  });

  it("still supports publishing a piece outright, for a round that wants it", () => {
    expect(visiblePiece(entry(), "published")).toBe("https://youtu.be/assigned");
    expect(ROUND_REVEAL[0]).toBe("published");
  });

  it("shows nothing at all when no piece is assigned", () => {
    expect(visiblePiece({}, "published")).toBeUndefined();
    expect(pieceReady({}).ok).toBe(false);
  });

  it("warns that the button does both things, and that it can't be undone", () => {
    const warning = startWarning("on-start", WINDOW);
    expect(warning).toContain("starts your clock");
    expect(warning).toContain("learn it, record");
    expect(warning).toContain("can't be undone");
  });

  it("warns only about the clock when the piece is already public", () => {
    const warning = startWarning("published", WINDOW);
    expect(warning).toContain("starts your clock");
    expect(warning).not.toContain("shows you your piece");
  });
});


describe("Round 2's outcome is derived, so the bar can move", () => {
  const settled = scores({ performance: 6.25, musicality: 6.25 });

  it("re-derives when the bar moves, without touching the record", () => {
    // Weighted: 0.4(7.5) + 0.3(7.5) + 0.2(6.25) + 0.1(6.25) = 7.125
    expect(round2Outcome(settled, 7.0, FLOOR)).toBe("passed");
    expect(round2Outcome(settled, 7.5, FLOOR)).toBe("failed");
  });

  it("says nothing until there are scores", () => {
    expect(round2Outcome(undefined, 7.5, FLOOR)).toBeUndefined();
  });

  /**
   * The freeze point. Up to the send, moving the bar moves everyone together;
   * after it, the number they were told is the number that stands, because you
   * can't unsend a result.
   */
  it("freezes once the result has been sent, whatever the bar does after", () => {
    const record: DiamondsRecord = {
      discordId: "1",
      cohort: "new",
      rounds: {
        1: { submittedAt: "x", outcome: "advanced", resultSentAt: "x" },
        2: {
          submittedAt: "x",
          ballots: { d1: { scores: settled, at: "x" }, d2: { scores: settled, at: "x" } },
          outcome: "passed",
          resultSentAt: "2027-01-16T10:00:00.000Z",
          scoredAgainst: { bar: 7.0, floor: FLOOR, weights: DEFAULT_WEIGHTS },
        },
      },
    };
    // The bar has since risen past them, but they've already been told.
    const policy = { bar: 9, floor: FLOOR, requiredSteps: STEPS, minScores: 2, weights: DEFAULT_WEIGHTS };
    expect(settleRound(record, 2, policy)?.outcome).toBe("passed");
    expect(settleRound(record, 2, policy)?.against?.bar).toBe(7.0);
  });
});

describe("the returning-member document", () => {
  const good = {
    content: "https://docs.google.com/document/d/abc",
    strengths: ["holds the room", "clean lines", "never late"],
    growthAreas: ["accents land on the count"],
  };

  it("accepts three strengths and one growth area", () => {
    expect(validateDocument(good).ok).toBe(true);
  });

  it("refuses two strengths, naming the promise", () => {
    const check = validateDocument({ ...good, strengths: ["a", "b"] });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("three evident strengths");
  });

  it("refuses four growth areas and refuses none", () => {
    expect(validateDocument({ ...good, growthAreas: ["a", "b", "c", "d"] }).ok).toBe(false);
    expect(validateDocument({ ...good, growthAreas: [] }).ok).toBe(false);
  });

  it("ignores blank entries rather than counting them", () => {
    const padded = validateDocument({ ...good, strengths: ["a", "  ", "b", "c", ""] });
    expect(padded.ok).toBe(true);
    if (padded.ok) expect(padded.strengths).toEqual(["a", "b", "c"]);
  });
});

describe("sealing the baseline", () => {
  const record = (over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
    discordId: "1",
    cohort: "returning",
    rounds: {},
    ...over,
  });

  it("stores the scores and fixes the target in one step", () => {
    const fixed = fixTarget(
      record(),
      "timing drifts late in the second eight",
      3.75,
      "2026-11-17T10:00:00.000Z",
    );
    expect(fixed.ok).toBe(true);
    if (fixed.ok) {
      expect(fixed.record.target).toBe("timing drifts late in the second eight");
      // The before-number for the delta — a direct read of that one thing,
      // which is why no dimension score is involved in producing it.
      expect(fixed.record.targetBefore).toBe(3.75);
      expect(fixed.record.targetFixedAt).toBe("2026-11-17T10:00:00.000Z");
    }
  });

  it("refuses to move the target once it's fixed", () => {
    const already = record({
      targetFixedAt: "2026-11-17T10:00:00.000Z",
      target: "weak arms",
      targetBefore: 4,
    });
    const check = fixTarget(already, "poor timing", 2, "2026-11-20T10:00:00.000Z");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("can't be changed");
  });

  it("lists documents written but not yet delivered", () => {
    const written = record({
      document: { ...good_doc, deliveredAt: undefined },
    });
    const sent = record({ discordId: "2", document: { ...good_doc, deliveredAt: "2026-11-18T10:00:00.000Z" } });
    expect(awaitingDelivery([written, sent])).toHaveLength(1);
  });
});

const good_doc = {
  content: "https://docs.google.com/document/d/abc",
  strengths: ["a", "b", "c"],
  growthAreas: ["d"],
  writtenBy: "111",
  submittedAt: "2026-11-17T10:00:00.000Z",
};

describe("responding to a leaked Round 2 piece", () => {
  const person = (id: string, over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
    discordId: id,
    cohort: "new",
    rounds: {},
    ...over,
  });

  const round: Round = 2;

  it("names only the people who haven't opened a window", () => {
    const notStarted = person("1", { rounds: { 2: { assignedPiece: "https://a" } } });
    const midWindow = person("2", {
      rounds: { 2: { assignedPiece: "https://a", windowOpenedAt: "2026-12-22T10:00:00.000Z" } },
    });
    const done = person("3", {
      rounds: {
        2: {
          assignedPiece: "https://a",
          windowOpenedAt: "2026-12-22T10:00:00.000Z",
          submittedAt: "2026-12-24T10:00:00.000Z",
        },
      },
    });

    const swap = notYetStarted([notStarted, midWindow, done], round);
    expect(swap.map((r) => r.discordId)).toEqual(["1"]);
  });

  it("leaves out anyone who has withdrawn", () => {
    const gone = person("4", { withdrawnAt: "2026-12-01T10:00:00.000Z" });
    expect(notYetStarted([gone], round)).toHaveLength(0);
  });

  it("counts someone with no record for the round at all", () => {
    expect(notYetStarted([person("5")], round)).toHaveLength(1);
  });
});

/**
 * The before-number, set with the piece. It is a direct read of one named
 * weakness rather than anything derived from Round 0 — which is the point, so
 * these guard the two ways it could be meaningless: words with no number
 * behind them, or a number off the ladder it will be compared on.
 */
describe("the target's before-score", () => {
  const record = (): DiamondsRecord => ({
    discordId: "1",
    cohort: "returning",
    rounds: {},
  });

  it("refuses a target with no number to move", () => {
    const check = fixTarget(record(), "weak arms", Number.NaN, "2026-11-17T10:00:00.000Z");
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/0 to 10/);
  });

  it("refuses a number off the ladder", () => {
    for (const off of [-1, 11]) {
      expect(fixTarget(record(), "weak arms", off, "x").ok).toBe(false);
    }
  });

  it("refuses a target with no words", () => {
    const check = fixTarget(record(), "   ", 4, "x");
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/not a dimension/);
  });

  /**
   * The pair the delta is actually computed from, end to end: fixed at 4 when
   * the piece went up, scored at 6.25 after — 1.8 anchor steps, which clears a
   * one-step rule.
   */
  it("feeds the delta rule", () => {
    const fixed = fixTarget(record(), "weak arms", 4, "x");
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    const moved = advancesRound1(fixed.record.targetBefore!, 6.25, BAR, STEPS);
    expect(moved.advanced).toBe(true);
    expect(moved.because).toBe("improved");
  });
});

/**
 * Rolling rounds: which round you're in is a fact about your record, not about
 * today's date. There is no cohort to be in step with.
 */
describe("moving through the rounds at your own pace", () => {
  const now = at("2026-12-01T12:00:00.000Z");
  const who = (over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
    discordId: "1",
    cohort: "new",
    rounds: {},
    ...over,
  });

  it("starts everyone at Round 0", () => {
    expect(activeRound(who(), now)).toEqual({ ok: true, round: 0 });
  });

  // The round turns on the feedback having *gone out*. There was briefly a
  // `readAt` in between, so that a document nobody had opened didn't open
  // anything either — and the button it needed turned out to be a step in front
  // of the piece for no gain. The pass carries the start button now instead.
  it("opens Round 1 the moment their feedback goes out, whenever that is", () => {
    const early = who({
      rounds: { 0: { submittedAt: "2026-11-16T00:00:00.000Z" } },
      document: {
        content: "x",
        strengths: ["a", "b", "c"],
        growthAreas: ["arms"],
        writtenBy: "d1",
        submittedAt: "2026-11-17T00:00:00.000Z",
        deliveredAt: "2026-11-17T00:00:00.000Z",
      },
    });
    expect(activeRound(early, at("2026-11-17T00:01:00.000Z"))).toEqual({ ok: true, round: 1 });
    // And the same record a month later is still in Round 1 — no phase moved
    // on without them.
    expect(activeRound(early, at("2026-12-20T00:00:00.000Z"))).toEqual({ ok: true, round: 1 });
  });

  /** A returning Diamond submits nothing, so the document *is* their Round 0. */
  it("opens Round 1 for a returning Diamond when their feedback goes out", () => {
    const waiting = who({ cohort: "returning" });
    expect(activeRound(waiting, now)).toEqual({ ok: true, round: 0 });

    const sent = who({
      cohort: "returning",
      document: {
        content: "x",
        strengths: ["a", "b", "c"],
        growthAreas: ["d"],
        writtenBy: "d1",
        submittedAt: "2026-11-18T00:00:00.000Z",
        deliveredAt: "2026-11-18T00:00:00.000Z",
      },
    });
    expect(activeRound(sent, now)).toEqual({ ok: true, round: 1 });
  });

  it("does not open Round 1 on feedback that never reached them", () => {
    const undelivered = who({
      cohort: "returning",
      document: {
        content: "x",
        strengths: ["a", "b", "c"],
        growthAreas: ["d"],
        writtenBy: "d1",
        submittedAt: "2026-11-18T00:00:00.000Z",
      },
    });
    expect(activeRound(undelivered, now)).toEqual({ ok: true, round: 0 });
  });

  it("opens Round 2 on a Round 1 submission", () => {
    const through = who({ rounds: { 1: { submittedAt: "2026-11-25T00:00:00.000Z" } } });
    expect(activeRound(through, now)).toEqual({ ok: true, round: 2 });
  });

  it("ends the audition on a round that didn't go their way", () => {
    const done = activeRound(who({ rounds: { 1: { outcome: "failed" } } }), now);
    expect(done.ok).toBe(false);
    expect(done.ok === false && done.reason).toMatch(/finished at Round 1/);
  });

  /**
   * And a practice round ends nothing, which is the point of it: somebody
   * carried into Round 2 after a Round 1 fail is still going, and so is someone
   * who asked for practice from the start.
   */
  it("keeps going after a practice round", () => {
    const carried = who({
      practiceFrom: 2,
      document: {
        content: "x",
        strengths: ["a", "b", "c"],
        growthAreas: ["arms"],
        writtenBy: "d1",
        submittedAt: "2026-11-18T00:00:00.000Z",
        deliveredAt: "2026-11-18T00:00:00.000Z",
      },
      rounds: { 1: { submittedAt: "x", resultSentAt: "y", outcome: "practice" } },
    });
    expect(activeRound(carried, now)).toEqual({ ok: true, round: 2 });
  });
});

/**
 * The gap. Round 1 asks what someone did about a named weakness, and a dancer
 * who gets the feedback and the piece in the same minute has had no time to do
 * anything about it — the round would measure whether a weakness can be hidden
 * for three days instead.
 */
/**
 * Round 1's one prerequisite. Not a countdown — a countdown can expire before
 * anyone has told the dancer anything, which is the state it existed to
 * prevent.
 */
describe("Round 1 waits on the feedback", () => {
  const delivered = (at = "2026-11-18T00:00:00.000Z") => ({
    content: "x",
    strengths: ["a", "b", "c"],
    growthAreas: ["arms"],
    writtenBy: "d1",
    submittedAt: at,
    deliveredAt: at,
  });

  const who = (over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
    discordId: "1",
    cohort: "new",
    rounds: {
      0: { submittedAt: "2026-11-16T00:00:00.000Z" },
      1: { assignedPiece: "https://p", assignedAt: "2026-11-18T00:00:00.000Z" },
    },
    ...over,
  });

  it("refuses a start before the feedback has landed, and says it's not their fault", () => {
    const check = canStartWindow(who(), 1, WINDOW, at("2026-11-19T00:00:00.000Z"));
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toMatch(/hasn.t gone out yet/);
      expect(check.reason).toMatch(/It.ll arrive with your piece/);
    }
  });

  it("allows it the moment the feedback has", () => {
    expect(
      canStartWindow(
        who({ document: delivered() }),
        1,
        WINDOW,
        at("2026-11-19T00:00:00.000Z"),
      ),
    ).toEqual({ ok: true });
  });

  /** Written but undelivered is not delivered — a failed DM blocks nothing open. */
  it("doesn't count feedback that never arrived", () => {
    const undelivered = who({
      document: { ...delivered(), deliveredAt: undefined },
    });
    expect(feedbackReady(undelivered, 1).ok).toBe(false);
    expect(activeRound(undelivered, at("2026-11-19T00:00:00.000Z"))).toEqual({
      ok: true,
      round: 0,
    });
  });

  it("asks nothing of Rounds 0 and 2 — neither is a response to feedback", () => {
    expect(feedbackReady(who(), 0).ok).toBe(true);
    expect(feedbackReady(who(), 2).ok).toBe(true);
  });

  /**
   * One gate for both cohorts. The newcomer earns the feedback by submitting a
   * cover and the returning Diamond doesn't, but the thing that opens Round 1 is
   * the same event.
   */
  it("is the same gate for a returning Diamond, who submits nothing", () => {
    const returning = who({ cohort: "returning", rounds: {} });
    expect(activeRound(returning, at("2026-11-19T00:00:00.000Z"))).toEqual({
      ok: true,
      round: 0,
    });
    expect(
      activeRound(
        { ...returning, document: delivered() },
        at("2026-11-19T00:00:00.000Z"),
      ),
    ).toEqual({ ok: true, round: 1 });
  });
});


/**
 * Sealed ballots. The seal matters more with two directors than with three:
 * with three a visible tally nudges the third, with two the first number
 * effectively decides the second.
 */
describe("tallying sealed ballots", () => {
  const withBallots = (ballots: Record<string, { scores?: Scores; targetScore?: number }>) =>
    entry({
      submittedAt: "x",
      ballots: Object.fromEntries(
        Object.entries(ballots).map(([by, one]) => [by, { ...one, at: "x" }]),
      ),
    });

  it("shows a count and nothing else until the last ballot is in", () => {
    const one = tally(withBallots({ d1: { scores: scores() } }), 2);
    expect(one).toEqual({ count: 1, complete: false });
    expect(one.scores).toBeUndefined();
  });

  /** A measurement on a shared ladder, so the mean rather than a vote. */
  it("averages once complete", () => {
    const both = tally(
      withBallots({
        d1: { scores: scores({ technicality: 6 }) },
        d2: { scores: scores({ technicality: 8 }) },
      }),
      2,
    );
    expect(both.complete).toBe(true);
    expect(both.scores?.technicality).toBe(7);
  });

  /**
   * A mean over a subset would answer a different question with the same
   * confidence, so a half-filled set of ballots yields nothing.
   */
  it("won't average a dimension only one of them scored", () => {
    const mixed = tally(withBallots({ d1: { scores: scores() }, d2: { targetScore: 5 } }), 2);
    expect(mixed.complete).toBe(true);
    expect(mixed.scores).toBeUndefined();
    expect(mixed.targetScore).toBeUndefined();
  });

  it("averages the target score on its own", () => {
    const both = tally(withBallots({ d1: { targetScore: 4 }, d2: { targetScore: 5.5 } }), 2);
    expect(both.targetScore).toBe(4.75);
  });

  /** Dropping the threshold to 1 is the documented recusal escape hatch. */
  it("settles on one ballot when the threshold says so", () => {
    expect(tally(withBallots({ d1: { scores: scores() } }), 1).complete).toBe(true);
  });

  /**
   * The mean of 4 and 9 looks exactly like the mean of 6 and 7 and means
   * something completely different. Two directors have no tiebreak, so this is
   * surfaced rather than refused.
   */
  it("flags a disagreement wider than one anchor step", () => {
    const split = ballotSplits(
      withBallots({
        d1: { scores: scores({ execution: 4 }), targetScore: 3 },
        d2: { scores: scores({ execution: 9 }), targetScore: 3.5 },
      }),
    );
    expect(split).toEqual([{ what: "execution", low: 4, high: 9 }]);
  });

  it("says nothing about a disagreement inside one step", () => {
    expect(
      ballotSplits(
        withBallots({
          d1: { scores: scores({ execution: 6 }) },
          d2: { scores: scores({ execution: 7 }) },
        }),
      ),
    ).toEqual([]);
  });

  it("has nothing to compare with a single ballot", () => {
    expect(ballotSplits(withBallots({ d1: { scores: scores({ execution: 1 }) } }))).toEqual([]);
  });
});

describe("which round is waiting to be scored", () => {
  const who = (over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
    discordId: "1",
    cohort: "new",
    rounds: {},
    ...over,
  });

  const fixed = { targetFixedAt: "x", target: "weak arms", targetBefore: 4 };
  /** Round 0 decided and told, which is the only thing that clears it. */
  const zeroDone = { submittedAt: "x", outcome: "passed" as const, resultSentAt: "x" };

  /**
   * Not the round they're *in*. Someone who submitted Round 1 is waiting on a
   * Round 2 piece as far as `activeRound` cares, while the thing on a
   * director's desk is their Round 1 video.
   */
  it("is Round 0 until its result has actually gone out", () => {
    expect(roundToScore(who({ rounds: { 0: { submittedAt: "x" } } }), 2)).toBe(0);
    // Both verdicts in but nothing sent: still ours, because a decision
    // nobody has been told is a decision that hasn't landed.
    expect(
      roundToScore(
        who({
          rounds: {
            0: {
              submittedAt: "x",
              ballots: { d1: { verdict: "pass", at: "x" }, d2: { verdict: "pass", at: "x" } },
            },
          },
        }),
        2,
      ),
    ).toBe(0);
  });

  it("waits for a newcomer's cover, but not a returning Diamond's", () => {
    expect(roundToScore(who(), 2)).toBeUndefined();
    expect(roundToScore(who({ cohort: "returning" }), 2)).toBe(0);
  });

  it("is the submitted round, not the round they're in", () => {
    const record = who({
      ...fixed,
      rounds: { 0: zeroDone, 1: { submittedAt: "y" } },
    });
    expect(activeRound(record, at("2026-12-01T00:00:00.000Z"))).toEqual({ ok: true, round: 2 });
    expect(roundToScore(record, 2)).toBe(1);
  });

  it("moves on once a result has been sent", () => {
    const record = who({
      ...fixed,
      rounds: {
        0: zeroDone,
        1: { submittedAt: "y", outcome: "advanced", resultSentAt: "z" },
        2: { submittedAt: "w" },
      },
    });
    expect(roundToScore(record, 2)).toBe(2);
  });

  it("has nothing to say about someone who withdrew", () => {
    expect(roundToScore(who({ withdrawnAt: "x", cohort: "returning" }), 2)).toBeUndefined();
  });
});

describe("settling a round", () => {
  const POLICY = {
    bar: BAR,
    floor: FLOOR,
    requiredSteps: STEPS,
    minScores: 2,
    weights: DEFAULT_WEIGHTS,
  };

  const record = (over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
    discordId: "1",
    cohort: "new",
    targetFixedAt: "x",
    target: "weak arms",
    targetBefore: 4,
    rounds: { 0: { submittedAt: "x" } },
    ...over,
  });

  const ballots = (
    one: { scores?: Scores; targetScore?: number; verdict?: Verdict },
    two = one,
  ) => ({
    d1: { ...one, at: "x" },
    d2: { ...two, at: "x" },
  });

  it("gives Round 1 an outcome from the delta, not the bar", () => {
    const moved = settleRound(
      record({ rounds: { 1: { submittedAt: "x", ballots: ballots({ targetScore: 6.5 }) } } }),
      1,
      POLICY,
    );
    expect(moved?.outcome).toBe("advanced");
    expect(moved?.advancement?.because).toBe("improved");
    // And carries no bar, because Round 1 never went near it.
    expect(moved?.against).toBeUndefined();
  });

  /**
   * "practice" rather than "failed": the announcement invites people to keep
   * going after not advancing, so "didn't advance but is still in" has to be
   * representable.
   */
  /**
   * Not moving it is a fail, and the gentler ending is now a director's choice
   * rather than a word the bot picks. The two used to be one outcome called
   * "practice", which meant the audition was over and nobody could tell.
   */
  it("calls a Round 1 that didn't move a failure", () => {
    const stuck = settleRound(
      record({ rounds: { 1: { submittedAt: "x", ballots: ballots({ targetScore: 4.25 }) } } }),
      1,
      POLICY,
    );
    expect(stuck?.outcome).toBe("failed");
  });

  /** And a round nobody was judging settles as practice, deciding nothing. */
  it("settles a practice round as practice, with no verdict in it", () => {
    const asked = record({
      practiceFrom: 0,
      rounds: { 1: { submittedAt: "x", ballots: ballots({ targetScore: 4.25 }) } },
    });
    expect(settleRound(asked, 1, POLICY)?.outcome).toBe("practice");
    // Even a delta that would have advanced them: nothing is being decided.
    const moved = record({
      practiceFrom: 0,
      rounds: { 1: { submittedAt: "x", ballots: ballots({ targetScore: 9 }) } },
    });
    expect(settleRound(moved, 1, POLICY)?.outcome).toBe("practice");
  });

  /** Round 0 practice settles on the document alone — there's no verdict. */
  it("settles a practice Round 0 as soon as the feedback is written", () => {
    expect(settleRound(record({ practiceFrom: 0 }), 0, POLICY)).toBeUndefined();
    const written = record({
      practiceFrom: 0,
      document: {
        content: "x",
        strengths: ["a", "b", "c"],
        growthAreas: ["arms"],
        writtenBy: "d1",
        submittedAt: "y",
      },
    });
    expect(settleRound(written, 0, POLICY)?.outcome).toBe("practice");
  });

  it("won't settle Round 1 without the before-number that was fixed at assignment", () => {
    const noBefore = record({
      targetFixedAt: undefined,
      targetBefore: undefined,
      rounds: { 1: { submittedAt: "x", ballots: ballots({ targetScore: 9 }) } },
    });
    expect(settleRound(noBefore, 1, POLICY)).toBeUndefined();
  });

  it("won't settle anything on too few ballots", () => {
    const half = record({
      rounds: { 1: { submittedAt: "x", ballots: { d1: { targetScore: 9, at: "x" } } } },
    });
    expect(settleRound(half, 1, POLICY)).toBeUndefined();
  });

  it("gives Round 2 an outcome from the bar, and records which bar", () => {
    const passed = settleRound(
      record({ rounds: { 2: { submittedAt: "x", ballots: ballots({ scores: scores() }) } } }),
      2,
      POLICY,
    );
    expect(passed?.outcome).toBe("passed");
    expect(passed?.against).toEqual({ bar: BAR, floor: FLOOR, weights: DEFAULT_WEIGHTS });
  });

  it("settles Round 0 from two agreeing verdicts, and carries no numbers", () => {
    const through = settleRound(
      record({ rounds: { 0: { submittedAt: "x", ballots: ballots({ verdict: "pass" }) } } }),
      0,
      POLICY,
    );
    expect(through?.outcome).toBe("passed");
    expect(through?.against).toBeUndefined();
    expect(through?.advancement).toBeUndefined();

    const out = settleRound(
      record({ rounds: { 0: { submittedAt: "x", ballots: ballots({ verdict: "fail" }) } } }),
      0,
      POLICY,
    );
    expect(out?.outcome).toBe("failed");
  });

  /**
   * The case with no good automatic answer. Two directors, one each: there is
   * no majority and no mean to take, so nothing settles and the two of them
   * have to talk. Deciding it either way here would be inventing a tiebreak.
   */
  it("won't settle a Round 0 the two of them disagree on", () => {
    const split = settleRound(
      record({
        rounds: {
          0: {
            submittedAt: "x",
            ballots: ballots({ verdict: "pass" }, { verdict: "fail" }),
          },
        },
      }),
      0,
      POLICY,
    );
    expect(split).toBeUndefined();
  });

  /** Round 0's verdict never becomes Round 1's before-number. */
  it("keeps Round 0 out of Round 1's delta entirely", () => {
    const passedZero = record({
      targetFixedAt: undefined,
      target: undefined,
      targetBefore: undefined,
      rounds: {
        0: { submittedAt: "x", ballots: ballots({ verdict: "pass" }) },
        1: { submittedAt: "x", ballots: ballots({ targetScore: 9 }) },
      },
    });
    expect(settleRound(passedZero, 0, POLICY)?.outcome).toBe("passed");
    // Passing Round 0 supplies nothing Round 1 can measure against. Only
    // `fixTarget`, at assignment, does that.
    expect(settleRound(passedZero, 1, POLICY)).toBeUndefined();
  });
});

describe("what a ballot has to carry", () => {
  it("asks Round 1 for the target score and nothing else", () => {
    expect(ballotComplete(1, { targetScore: 6, at: "x" }).ok).toBe(true);
    const missing = ballotComplete(1, { scores: scores(), at: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/the one thing you named/);
  });

  it("asks Round 2 for the four dimensions", () => {
    expect(ballotComplete(2, { scores: scores(), at: "x" }).ok).toBe(true);
    expect(ballotComplete(2, { targetScore: 6, at: "x" }).ok).toBe(false);
  });

  /** Round 0 asks a question, not for a measurement. */
  it("asks Round 0 for a verdict and refuses numbers in its place", () => {
    expect(ballotComplete(0, { verdict: "pass", at: "x" }).ok).toBe(true);
    expect(ballotComplete(0, { verdict: "fail", at: "x" }).ok).toBe(true);
    const scored = ballotComplete(0, { scores: scores(), targetScore: 4, at: "x" });
    expect(scored.ok).toBe(false);
    if (!scored.ok) expect(scored.reason).toMatch(/pass or a fail/);
  });
});

/**
 * The one place a score arrives as text. Discord has no number input, so a
 * modal ballot is a string, and the failure that matters is silent: `Number("")`
 * is 0 and 0 is a real score.
 */
describe("a score off a form", () => {
  it("takes a number on the ladder, whole or half", () => {
    expect(parseScore("7")).toBe(7);
    expect(parseScore("7.5")).toBe(7.5);
    expect(parseScore(" 10 ")).toBe(10);
    expect(parseScore("0")).toBe(0);
  });

  it("refuses an empty box rather than calling it a zero", () => {
    expect(parseScore("")).toBeUndefined();
    expect(parseScore("   ")).toBeUndefined();
  });

  it("refuses what isn't a number on this ladder", () => {
    expect(parseScore("7,5")).toBeUndefined();
    expect(parseScore("eight")).toBeUndefined();
    expect(parseScore("11")).toBeUndefined();
    expect(parseScore("-1")).toBeUndefined();
    expect(parseScore("7.5.5")).toBeUndefined();
  });
});

/**
 * The rule as the directors wrote it out, row for row. Kept as their own table
 * rather than as a restatement of the implementation, because the thing most
 * likely to go wrong here is the implementation quietly disagreeing with what
 * was decided — and a test that derives its expectations the same way the code
 * does would never catch it.
 */
describe("the enforcement date", () => {
  const passed = (iso: string) => enforcementFor(iso).slice(0, 10);

  it("sends January, February and March to the January a year out", () => {
    expect(passed("2027-01-15T12:00:00.000Z")).toBe("2028-01-01");
    expect(passed("2027-02-15T12:00:00.000Z")).toBe("2028-01-01");
    expect(passed("2027-03-15T12:00:00.000Z")).toBe("2028-01-01");
  });

  it("sends April through September to the July a year out", () => {
    expect(passed("2027-04-15T12:00:00.000Z")).toBe("2028-07-01");
    expect(passed("2027-05-15T12:00:00.000Z")).toBe("2028-07-01");
    expect(passed("2027-06-15T12:00:00.000Z")).toBe("2028-07-01");
    expect(passed("2027-07-15T12:00:00.000Z")).toBe("2028-07-01");
    expect(passed("2027-08-15T12:00:00.000Z")).toBe("2028-07-01");
    expect(passed("2027-09-15T12:00:00.000Z")).toBe("2028-07-01");
  });

  it("sends October, November and December to the January two years out", () => {
    expect(passed("2027-10-15T12:00:00.000Z")).toBe("2029-01-01");
    expect(passed("2027-11-15T12:00:00.000Z")).toBe("2029-01-01");
    expect(passed("2027-12-15T12:00:00.000Z")).toBe("2029-01-01");
  });

  /** October and the following March are one window, so they share a date. */
  it("puts October and the following February on the same date", () => {
    expect(passed("2027-10-01T12:00:00.000Z")).toBe(passed("2028-02-01T12:00:00.000Z"));
  });

  it("never gives less than nine months or more than fifteen", () => {
    for (const month of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const iso = `2027-${String(month).padStart(2, "0")}-28T12:00:00.000Z`;
      const months =
        (new Date(enforcementFor(iso)).getTime() - new Date(iso).getTime()) /
        (30.44 * 24 * 60 * 60 * 1000);
      expect(months).toBeGreaterThanOrEqual(9);
      expect(months).toBeLessThanOrEqual(15);
    }
  });

  /**
   * Built at midnight Eastern rather than midnight UTC, so that the date a New
   * York reader sees is the date the rule names.
   */
  it("lands on the first of the month, not the evening before", () => {
    expect(enforcementFor("2027-11-15T12:00:00.000Z")).toBe("2029-01-01T05:00:00.000Z");
    expect(enforcementFor("2027-05-15T12:00:00.000Z")).toBe("2028-07-01T04:00:00.000Z");
  });

  /**
   * The property the "re-audition whenever you like" policy rests on: going
   * again can never hand you an earlier date than the one you already have, so
   * there is no month in which waiting is worth more than going, and nothing
   * for the bot to protect people from.
   */
  it("never moves anyone's date backwards", () => {
    let previous = 0;
    for (let month = 0; month < 36; month += 1) {
      const iso = new Date(Date.UTC(2027, month, 15)).toISOString();
      const date = new Date(enforcementFor(iso)).getTime();
      expect(date).toBeGreaterThanOrEqual(previous);
      previous = date;
    }
  });

  /** Going early in your half is worth five months, which is the incentive. */
  it("pays for auditioning early in the window", () => {
    const early = new Date(enforcementFor("2027-10-01T12:00:00.000Z")).getTime() -
      new Date("2027-10-01T12:00:00.000Z").getTime();
    const late = new Date(enforcementFor("2028-03-01T12:00:00.000Z")).getTime() -
      new Date("2028-03-01T12:00:00.000Z").getTime();
    expect(early).toBeGreaterThan(late);
  });
});

/**
 * What a member is told when they come back and look.
 */
describe("after the process is finished", () => {
  const passed: DiamondsRecord = {
    discordId: "100",
    cohort: "new",
    rounds: {
      0: { submittedAt: "2027-11-01T00:00:00.000Z", resultSentAt: "2027-11-02T00:00:00.000Z", outcome: "passed" },
      1: { submittedAt: "2027-11-05T00:00:00.000Z", resultSentAt: "2027-11-08T00:00:00.000Z", outcome: "advanced" },
      2: { submittedAt: "2027-11-12T00:00:00.000Z", resultSentAt: "2027-11-15T00:00:00.000Z", outcome: "passed" },
    },
    memberSince: "2027-11-15T00:00:00.000Z",
    enforcedAt: "2029-01-01T05:00:00.000Z",
  };

  /**
   * The bug this replaces: keyed on having submitted Round 2, a member who
   * passed a year ago was told "waiting on your result — nothing to do".
   */
  it("tells someone who passed that they're done and can go again", () => {
    const state = activeRound(passed, at("2028-06-01T00:00:00.000Z"));
    expect(state.ok).toBe(false);
    expect(state.ok === false && state.reason).toMatch(/You're a Diamond/);
    expect(state.ok === false && state.reason).toMatch(/whenever you like/);
    expect(state.ok === false && state.reason).not.toMatch(/[Ww]aiting/);
  });

  it("still says 'waiting' to someone whose result hasn't been sent", () => {
    const pending: DiamondsRecord = {
      ...passed,
      rounds: { ...passed.rounds, 2: { submittedAt: "2027-11-12T00:00:00.000Z" } },
    };
    const state = activeRound(pending, at("2027-11-13T00:00:00.000Z"));
    expect(state.ok === false && state.reason).toMatch(/Waiting on your result/);
  });

  it("doesn't dress up a Round 2 failure as membership", () => {
    const failed: DiamondsRecord = {
      ...passed,
      rounds: { ...passed.rounds, 2: { ...passed.rounds[2]!, outcome: "failed" } },
      memberSince: undefined,
      enforcedAt: undefined,
    };
    const state = activeRound(failed, at("2028-06-01T00:00:00.000Z"));
    expect(state.ok === false && state.reason).toMatch(/finished at Round 2/);
  });
});

describe("the renewal ladder", () => {
  const LADDER = [20, 30, 60];
  const member = (over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
    discordId: "100",
    cohort: "new",
    rounds: {},
    memberSince: "2027-11-15T00:00:00.000Z",
    enforcedAt: "2029-01-01T05:00:00.000Z",
    ...over,
  });

  it("says nothing while the date is further off than the widest rung", () => {
    expect(noticeDue(member(), LADDER, new Date("2028-10-01T12:00:00Z"))).toBeUndefined();
  });

  it("sends the two-month rung when two months are left", () => {
    const due = noticeDue(member(), LADDER, new Date("2028-11-05T12:00:00Z"));
    expect(due?.rung).toBe(60);
    expect(due?.daysLeft).toBeLessThanOrEqual(60);
  });

  /**
   * The failure this prevents: a sweep that was down for a fortnight, or a
   * member whose urgent notice went out first, receiving the gentle sixty-day
   * one afterwards.
   */
  it("sends only the most urgent rung reached, and answers for the rest", () => {
    const due = noticeDue(member(), LADDER, new Date("2028-12-20T12:00:00Z"));
    expect(due?.rung).toBe(20);
    expect(due?.covers).toEqual([20, 30, 60]);
  });

  it("doesn't send a rung twice", () => {
    const sent = member({ renewalNoticedAt: { "20": "2028-12-20T12:00:00.000Z" } });
    expect(noticeDue(sent, LADDER, new Date("2028-12-21T12:00:00Z"))).toBeUndefined();
  });

  it("still sends the urgent rung to someone who only had the gentle one", () => {
    const sent = member({ renewalNoticedAt: { "60": "2028-11-05T12:00:00.000Z" } });
    expect(noticeDue(sent, LADDER, new Date("2028-12-20T12:00:00Z"))?.rung).toBe(20);
  });

  /** Past the date is the removal job's business. A fourth warning isn't it. */
  it("stops once the date has gone", () => {
    expect(noticeDue(member(), LADDER, new Date("2029-01-02T12:00:00Z"))).toBeUndefined();
  });

  it("says nothing to someone with no membership to renew", () => {
    expect(
      noticeDue(member({ enforcedAt: undefined }), LADDER, new Date("2028-12-20T12:00:00Z")),
    ).toBeUndefined();
  });

  /**
   * Withdrawing leaves the audition, not Diamonds — and a member who dropped a
   * re-audition is the likeliest person in the system to reach their date, so
   * silence is exactly what would take them there.
   */
  it("still warns a member who dropped their re-audition", () => {
    const dropped = member({ withdrawnAt: "2028-12-01T00:00:00.000Z" });
    expect(noticeDue(dropped, LADDER, new Date("2028-12-20T12:00:00Z"))?.rung).toBe(20);
  });

  /**
   * Nobody mid-re-audition gets told they're about to be removed — they are
   * doing the thing the notice asks for.
   */
  /**
   * A live re-audition is one registered since their membership started. The
   * finished one it replaced is in `history`, so `rounds` is the new audition
   * and only the dates say which term it belongs to.
   */
  it("goes quiet while a re-audition is in flight", () => {
    const going = member({
      registeredAt: "2028-11-20T00:00:00.000Z",
      rounds: { 0: { submittedAt: "2028-12-01T00:00:00.000Z" } },
    });
    expect(renewalUnderway(going)).toBe(true);
    expect(noticeDue(going, LADDER, new Date("2028-12-20T12:00:00Z"))).toBeUndefined();
  });

  /** Registering counts, before they've submitted anything — the clock bounds it. */
  it("counts a registration with nothing submitted yet", () => {
    const signed = member({ registeredAt: "2028-11-20T00:00:00.000Z", rounds: {} });
    expect(renewalUnderway(signed)).toBe(true);
  });

  it("doesn't count the audition they joined on as a re-audition", () => {
    const joined = member({
      registeredAt: "2027-10-01T00:00:00.000Z",
      rounds: { 2: { submittedAt: "2027-11-01T00:00:00.000Z", resultSentAt: "2027-11-15T00:00:00.000Z" } },
    });
    expect(renewalUnderway(joined)).toBe(false);
  });

  /** And stops counting the moment that re-audition ends, however it ended. */
  it("stops counting once the re-audition is over", () => {
    const base = { registeredAt: "2028-11-20T00:00:00.000Z" };
    expect(renewalUnderway(member({ ...base, withdrawnAt: "2028-12-05T00:00:00.000Z", rounds: {} }))).toBe(
      false,
    );
    expect(renewalUnderway(member({ ...base, expiredAt: "2029-01-20T00:00:00.000Z", rounds: {} }))).toBe(
      false,
    );
    expect(
      renewalUnderway(
        member({ ...base, rounds: { 1: { submittedAt: "a", resultSentAt: "b", outcome: "failed" } } }),
      ),
    ).toBe(false);
  });

  it("counts whole days, so most of today still counts", () => {
    expect(daysUntil("2029-01-01T05:00:00.000Z", new Date("2028-12-31T20:00:00Z"))).toBe(1);
  });

  /**
   * `daysUntil` rounds up, so the afternoon of the date itself comes back as 0
   * rather than negative — which a `< 0` guard would have read as "still time"
   * and answered with a notice saying no days remained.
   */
  it("says nothing on the afternoon of the date itself", () => {
    // Negative zero, precisely: `Math.ceil(-0.6)` is `-0`, and `-0 < 0` is false.
    // That is the whole reason the guard compares instants instead.
    expect(daysUntil("2029-01-01T05:00:00.000Z", new Date("2029-01-01T20:00:00Z"))).toBe(-0);
    expect(noticeDue(member(), LADDER, new Date("2029-01-01T20:00:00Z"))).toBeUndefined();
  });
});

describe("starting again", () => {
  const done = (over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
    discordId: "100",
    cohort: "new",
    registeredAt: "2027-10-01T00:00:00.000Z",
    rounds: {
      0: { submittedAt: "2027-11-01T00:00:00.000Z", resultSentAt: "2027-11-02T00:00:00.000Z", outcome: "passed" },
      1: { submittedAt: "2027-11-05T00:00:00.000Z", resultSentAt: "2027-11-08T00:00:00.000Z", outcome: "advanced" },
      2: { submittedAt: "2027-11-12T00:00:00.000Z", resultSentAt: "2027-11-15T00:00:00.000Z", outcome: "passed" },
    },
    target: "elbows collapse on extensions",
    targetBefore: 4,
    targetFixedAt: "2027-11-03T00:00:00.000Z",
    document: {
      content: "A good season.",
      strengths: ["a", "b", "c"],
      growthAreas: ["arms"],
      writtenBy: "d1",
      submittedAt: "2027-11-02T00:00:00.000Z",
      deliveredAt: "2027-11-02T00:00:00.000Z",
    },
    memberSince: "2027-11-15T00:00:00.000Z",
    enforcedAt: "2029-01-01T05:00:00.000Z",
    ...over,
  });

  const NOW = "2028-11-01T00:00:00.000Z";

  it("puts the finished audition on file and hands back a clean one", () => {
    const again = reAudition(done(), NOW);
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    expect(again.record.rounds).toEqual({});
    expect(again.record.history).toHaveLength(1);
    expect(again.record.history?.[0]?.outcome).toBe("passed");
    expect(again.record.history?.[0]?.rounds[2]?.submissionUrl).toBeUndefined();
    expect(again.record.history?.[0]?.target).toBe("elbows collapse on extensions");
    expect(auditionNumber(again.record)).toBe(2);
  });

  /**
   * The three that hang off the record rather than off `rounds`, and so are the
   * easy ones to leave behind.
   */
  it("clears the target, its number and the document", () => {
    const again = reAudition(done(), NOW);
    expect(again.ok && again.record.target).toBeUndefined();
    expect(again.ok && again.record.targetBefore).toBeUndefined();
    // Left behind, `fixTarget` would refuse the new Round 1's target.
    expect(again.ok && again.record.targetFixedAt).toBeUndefined();
    // Left behind, the new Round 0 document would overwrite last year's result.
    expect(again.ok && again.record.document).toBeUndefined();
  });

  it("keeps the membership, which belongs to the term and not the audition", () => {
    const again = reAudition(done(), NOW);
    expect(again.ok && again.record.memberSince).toBe("2027-11-15T00:00:00.000Z");
    expect(again.ok && again.record.enforcedAt).toBe("2029-01-01T05:00:00.000Z");
  });

  /**
   * Cleared on the pass, where the date moves — not here. Clearing it here
   * would silence the ladder for anyone who started a re-audition and stopped.
   */
  it("leaves the notice markers alone", () => {
    const marked = done({ renewalNoticedAt: { "60": "2028-11-01T00:00:00.000Z" } });
    const again = reAudition(marked, NOW);
    expect(again.ok && again.record.renewalNoticedAt).toEqual({
      "60": "2028-11-01T00:00:00.000Z",
    });
  });

  it("makes a renewing member returning, so they owe no cover", () => {
    const again = reAudition(done(), NOW);
    expect(again.ok && again.record.cohort).toBe("returning");
    expect(again.ok && roundToScore(again.record, 2)).toBe(0);
  });

  /** Nobody has watched them do anything since, so they owe one again. */
  it("sends someone who didn't pass back to being a newcomer", () => {
    const failed = done({
      cohort: "new",
      rounds: {
        ...done().rounds,
        2: { ...done().rounds[2]!, outcome: "failed" },
      },
      memberSince: undefined,
      enforcedAt: undefined,
    });
    const again = reAudition(failed, NOW);
    expect(again.ok && again.record.cohort).toBe("new");
  });

  it("restarts the clock Round 1's gap counts from", () => {
    const again = reAudition(done(), NOW);
    expect(again.ok && again.record.registeredAt).toBe(NOW);
  });

  it("puts them back at Round 0", () => {
    const again = reAudition(done(), NOW);
    expect(again.ok && activeRound(again.record, at(NOW))).toEqual({ ok: true, round: 0 });
  });

  it("refuses while the audition is still going", () => {
    const midway = done({
      rounds: { 0: done().rounds[0]!, 1: { assignedPiece: "https://p" } },
      memberSince: undefined,
      enforcedAt: undefined,
    });
    const again = reAudition(midway, NOW);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toMatch(/hasn't finished/);
  });

  it("refuses a record that is already at the start", () => {
    const fresh: DiamondsRecord = { discordId: "100", cohort: "new", rounds: {} };
    expect(reAudition(fresh, NOW).ok).toBe(false);
  });

  it("stacks, so a third audition keeps both earlier ones", () => {
    const second = reAudition(done(), NOW);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const third = reAudition({ ...second.record, rounds: done().rounds }, "2029-11-01T00:00:00.000Z");
    expect(third.ok && third.record.history).toHaveLength(2);
    expect(third.ok && auditionNumber(third.record)).toBe(3);
  });

  /**
   * These two decide the same thing from different angles, and a record that
   * one called finished while the other called live would let somebody start a
   * second audition on top of a half-finished first.
   */
  it("agrees with activeRound about what counts as finished", () => {
    const cases: [string, DiamondsRecord, boolean][] = [
      ["passed Round 2", done(), true],
      [
        "failed Round 2",
        done({ rounds: { ...done().rounds, 2: { ...done().rounds[2]!, outcome: "failed" } } }),
        true,
      ],
      [
        // Not advancing at Round 1 is a fail now. "practice" means a round that
        // was never being judged, and one of those ends nothing.
        "failed at Round 1",
        done({
          rounds: {
            0: done().rounds[0]!,
            1: { submittedAt: "x", resultSentAt: "y", outcome: "failed" },
          },
        }),
        true,
      ],
      [
        "carried on into Round 2 as practice",
        done({
          practiceFrom: 2,
          rounds: {
            0: done().rounds[0]!,
            1: { submittedAt: "x", resultSentAt: "y", outcome: "practice" },
          },
        }),
        false,
      ],
      [
        "failed Round 0",
        done({ rounds: { 0: { submittedAt: "x", resultSentAt: "y", outcome: "failed" } } }),
        true,
      ],
      [
        "Round 2 in with no result",
        done({ rounds: { ...done().rounds, 2: { submittedAt: "2027-11-12T00:00:00.000Z" } } }),
        false,
      ],
      ["mid Round 1", done({ rounds: { 0: done().rounds[0]!, 1: { assignedPiece: "p" } } }), false],
    ];

    for (const [name, record, finished] of cases) {
      expect(auditionFinished(record), name).toBe(finished);
      // Whenever it is finished, activeRound must also have nothing to offer.
      if (finished) expect(activeRound(record, at(NOW)).ok, name).toBe(false);
    }
  });
});

describe("the wait after an audition that didn't pass", () => {
  const ended = (outcome: "passed" | "failed" | "practice", round: 0 | 1 | 2): DiamondsRecord => ({
    discordId: "100",
    cohort: "new",
    rounds: {
      ...(round >= 1
        ? { 0: { submittedAt: "a", resultSentAt: "2027-06-01T00:00:00.000Z", outcome: "passed" as const } }
        : {}),
      ...(round === 2
        ? { 1: { submittedAt: "b", resultSentAt: "2027-06-10T00:00:00.000Z", outcome: "advanced" as const } }
        : {}),
      [round]: { submittedAt: "c", resultSentAt: "2027-06-15T00:00:00.000Z", outcome },
    },
  });

  it("runs six months from the day the result went out", () => {
    expect(retryBlockedUntil(ended("failed", 2), 6)?.slice(0, 10)).toBe("2027-12-15");
  });

  /** All three mean the same thing about whether they're in. */
  it("applies at whichever round it ended", () => {
    expect(retryBlockedUntil(ended("failed", 0), 6)).toBeTruthy();
    expect(retryBlockedUntil(ended("failed", 1), 6)).toBeTruthy();
    expect(retryBlockedUntil(ended("failed", 2), 6)).toBeTruthy();
  });

  /**
   * And never after practice, which is the deal: someone who asked not to be
   * judged hasn't failed anything. A wait here would make asking for practice
   * the riskier choice of the two.
   */
  it("doesn't apply after a practice audition", () => {
    expect(retryBlockedUntil(ended("practice", 1), 6)).toBeUndefined();
    expect(retryBlockedUntil(ended("practice", 2), 6)).toBeUndefined();
  });

  it("doesn't apply to someone who passed", () => {
    expect(retryBlockedUntil(ended("passed", 2), 6)).toBeUndefined();
  });

  /** Withdrawing is leaving, not failing — there's no judgement to wait out. */
  it("doesn't apply to someone who withdrew part-way", () => {
    const left: DiamondsRecord = {
      discordId: "100",
      cohort: "new",
      rounds: { 0: { submittedAt: "a", resultSentAt: "x", outcome: "passed" }, 1: { assignedPiece: "p" } },
      withdrawnAt: "2027-06-20T00:00:00.000Z",
    };
    expect(retryBlockedUntil(left, 6)).toBeUndefined();
  });

  it("runs out", () => {
    const record = ended("failed", 2);
    expect(retryBlocked(record, 6, at("2027-12-14T00:00:00.000Z"))).toBeTruthy();
    expect(retryBlocked(record, 6, at("2027-12-16T00:00:00.000Z"))).toBeUndefined();
  });

  it("is off entirely at zero months", () => {
    expect(retryBlockedUntil(ended("failed", 2), 0)).toBeUndefined();
  });

  /** Over rather than under: the wait should never come out shorter. */
  it("never shortens itself on a long month", () => {
    const august: DiamondsRecord = {
      discordId: "100",
      cohort: "new",
      rounds: { 0: { submittedAt: "a", resultSentAt: "2027-08-31T00:00:00.000Z", outcome: "failed" } },
    };
    const until = new Date(retryBlockedUntil(august, 6)!);
    expect(until.getTime()).toBeGreaterThan(new Date("2028-02-29T00:00:00.000Z").getTime());
  });
});
