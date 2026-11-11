import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted, because vi.mock's factory is lifted above the imports and cannot
// reach a plain top-level const.
const { sendDirectMessage } = vi.hoisted(() => ({
  sendDirectMessage: vi.fn(
    async (
      _env: unknown,
      _userId: string,
      _payload: { content?: string },
    ): Promise<boolean> => true,
  ),
}));
vi.mock("../src/discord/rest", () => ({ sendDirectMessage }));

import {
  activeRound,
  composeFeedback,
  DEFAULT_WEIGHTS,
  feedbackRevealed,
  lastRound0At,
  roundOf,
  type DiamondsRecord,
  type DiamondsTimeline,
} from "../src/diamonds/audition";
import {
  ballotReceipt,
  parseDiamondsCustomId,
  rosterReadout,
  roundPanel,
  statusPanel,
} from "../src/diamonds/card";
import {
  getDiamondsTimeline,
  getDiamondsPolicy,
  inspectDiamondsConfig,
  resolveTimeline,
  setDiamondsTimeline,
  timelineProblems,
  type DiamondsPolicy,
} from "../src/diamonds/config";
import {
  addEntry,
  allRecords,
  assignPiece,
  assignToAll,
  fileFeedback,
  getRecord,
  grantExtension,
  noteRound,
  panelContext,
  planStart,
  register,
  runDiamondsSweep,
  scoreRound,
  sendResult,
  startWindow,
  submit,
  withdraw,
} from "../src/diamonds/flow";
import type { Env } from "../src/env";

/**
 * A KV double. Stores raw strings, because this module reads both kinds out of
 * the same namespace — records as JSON, config values as plain text — and a
 * double that only did one would hide a mix-up between them.
 */
function kvDouble(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    get: async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true as const,
      cursor: undefined,
    }),
  };
  return { kv, store };
}

function envWith(initial: Record<string, string> = {}) {
  const { kv, store } = kvDouble(initial);
  return { env: { KV: kv } as unknown as Env, store };
}

const seed = (record: DiamondsRecord): [string, string] => [
  `dia:rec:${record.discordId}`,
  JSON.stringify(record),
];

const dancer = (over: Partial<DiamondsRecord> = {}): DiamondsRecord => ({
  discordId: "100",
  displayName: "Ada",
  cohort: "new",
  rounds: {},
  ...over,
});

/** The announced timeline, which is also what the defaults resolve to. */
const TIMELINE: DiamondsTimeline = {
  opensAt: "2026-11-15T05:01:00.000Z",
  closesAt: "2027-01-11T04:59:00.000Z",
};

const POLICY: DiamondsPolicy = {
  windowDays: 3,
  bar: 7.5,
  floor: 6,
  requiredSteps: 1,
  nudgeDays: 3,
  headsUpDays: 10,
  reviewMinDays: 1,
  reviewMaxDays: 5,
  minScores: 2,
  weights: DEFAULT_WEIGHTS,
};

const CTX = panelContext(TIMELINE, POLICY);

/**
 * Round 1's target, as the directors set it when they put the piece up. The
 * before-number is theirs, not anything Round 0 produced.
 */
const sealed = {
  targetFixedAt: "2026-11-17T00:00:00.000Z",
  target: "elbows collapse on extensions",
  targetBefore: 4,
};

/** What `/diamonds assign` carries for Round 1. */
const TARGET = { note: "elbows collapse on extensions", before: 4 };

/** Both directors have called it a pass; nothing has been sent yet. */
const bothPass = (at = "2026-11-17T00:00:00.000Z") => ({
  submittedAt: "2026-11-16T00:00:00.000Z",
  ballots: {
    d1: { verdict: "pass" as const, at },
    d2: { verdict: "pass" as const, at },
  },
});

/** A Round 0 that passed and has been told, which is what opens Round 1. */
const zeroPassed = (at = "2026-11-17T00:00:00.000Z") => ({
  submittedAt: "2026-11-16T00:00:00.000Z",
  ballots: {
    d1: { verdict: "pass" as const, at },
    d2: { verdict: "pass" as const, at },
  },
  outcome: "passed" as const,
  outcomeAt: at,
  resultSentAt: at,
});

/** Feedback that reached them — the thing that opens Round 1. */
const feedbackSent = (at = "2026-11-18T00:00:00.000Z") => ({
  content: "A good season.",
  strengths: ["held the front line", "learned fast", "showed up"],
  growthAreas: ["arms"],
  writtenBy: "d1",
  submittedAt: at,
  deliveredAt: at,
});
/** A sweep that said nothing to anybody. */
/** The roster order the composed feedback follows. */
const DIRECTORS = ["d1", "d2"];
const quiet = { reminded: 0, nudged: 0, headsUp: 0, round0: 0, planned: 0 };
const OPEN = new Date("2026-11-18T00:00:00Z");

beforeEach(() => sendDirectMessage.mockClear());

describe("the timeline", () => {
  it("opens at the start of its day and closes at the end of its own", () => {
    const resolved = resolveTimeline({}, "America/New_York");
    // 00:01 and 23:59 in New York, which is what the announcement means by
    // "opens NOV 15" and "closes JAN 10".
    expect(resolved.opensAt).toBe("2026-11-15T05:01:00.000Z");
    expect(resolved.closesAt).toBe("2027-01-11T04:59:00.000Z");
  });

  /**
   * Pins the fixture the rest of this file reasons about to the shipped
   * defaults, so a timeline change can't quietly leave every other test
   * asserting against dates nobody is running.
   */
  it("is the timeline the rest of these tests assume", () => {
    expect(resolveTimeline({}, "America/New_York")).toEqual(TIMELINE);
  });

  it("falls back to the announced day when an override is malformed", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveTimeline({ closesAt: "Jan 10th" }, "America/New_York").closesAt).toBe(
      TIMELINE.closesAt,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("takes an override that is a real date", async () => {
    const { env } = envWith({ "config:diamonds.closes": "2027-01-24" });
    const resolved = await getDiamondsTimeline(env);
    expect(resolved.closesAt).toBe("2027-01-25T04:59:00.000Z");
    expect(resolved.opensAt).toBe(TIMELINE.opensAt);
  });

  it("reads the bar from KV so it can move without a deploy", async () => {
    const { env } = envWith({ "config:diamonds_bar": "7.1" });
    const policy = await getDiamondsPolicy(env);
    expect(policy.bar).toBe(7.1);
    expect(policy.floor).toBe(6);
    expect(policy.reviewMinDays).toBe(1);
    expect(policy.reviewMaxDays).toBe(5);
  });

  /**
   * The two dates get set one at a time, so the half-changed timeline is the
   * normal state rather than an edge case.
   */
  it("names a timeline nobody could finish", () => {
    expect(timelineProblems(TIMELINE, POLICY)).toEqual([]);
    expect(
      timelineProblems({ ...TIMELINE, closesAt: "2026-11-20T04:59:00.000Z" }, POLICY)[0],
    ).toMatch(/takes 16/);
    expect(
      timelineProblems({ opensAt: TIMELINE.closesAt, closesAt: TIMELINE.opensAt }, POLICY),
    ).toEqual(["Auditions close before they open."]);
  });
});

describe("setting the timeline before the flag goes on", () => {
  it("writes a date and reads the whole thing back", async () => {
    const { env } = envWith();
    expect((await setDiamondsTimeline(env, { closesAt: "2027-01-24" })).ok).toBe(true);
    const readout = await inspectDiamondsConfig(env);
    expect(readout.timeline.closesAt).toBe("2027-01-25T04:59:00.000Z");
    expect(readout.dateSources.closesAt).toBe("set");
    // And says which values are still whatever the code shipped with, because
    // that is the thing to check against the announcement before turning it on.
    expect(readout.dateSources.opensAt).toBe("default");
    expect(readout.enabled).toBe(false);
  });

  it("refuses anything that isn't a date", async () => {
    const { env } = envWith();
    expect((await setDiamondsTimeline(env, { closesAt: "Jan 10th" })).ok).toBe(false);
    expect((await setDiamondsTimeline(env, { closesAt: "2027-13-45" })).ok).toBe(false);
    expect((await setDiamondsTimeline(env, {})).ok).toBe(false);
  });

  it("warns when the Diamonds role isn't set, since everyone then counts as new", async () => {
    const { env } = envWith();
    expect((await inspectDiamondsConfig(env)).roleConfigured).toBe(false);
    const { env: configured } = envWith({ "config:role.diamonds": "123456789012345678" });
    expect((await inspectDiamondsConfig(configured)).roleConfigured).toBe(true);
  });
});

describe("registering", () => {
  it("is idempotent, and reads as being on the list rather than an error", async () => {
    const { env } = envWith();
    await register(env, "100", "Ada", "new", "2026-11-29", TIMELINE, OPEN);
    const second = await register(env, "100", "Ada L", "new", undefined, TIMELINE, OPEN);
    expect(second.ok).toBe(true);
    expect(second.ok && second.record.displayName).toBe("Ada L");
    // Leaving the estimate off keeps whatever was there rather than clearing it.
    expect(second.ok && roundOf(second.record, 0).plannedStartAt).toBe("2026-11-29");
  });

  /**
   * The estimate is the only way to see the review load coming: rolling rounds
   * spread two months of reviewing across a stream instead of one date.
   */
  it("keeps an updated estimate, against Round 0", async () => {
    const { env } = envWith();
    await register(env, "100", "Ada", "new", "2026-11-29", TIMELINE, OPEN);
    await register(env, "100", "Ada", "new", "2026-12-06", TIMELINE, OPEN);
    expect(roundOf((await getRecord(env, "100"))!, 0).plannedStartAt).toBe("2026-12-06");
  });

  it("doesn't touch a round that's already under way", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ rounds: { 1: { assignedPiece: "https://p", windowOpenedAt: "x" } } })),
      ]),
    );
    await register(env, "100", "Ada", "new", undefined, TIMELINE, OPEN);
    expect(roundOf((await getRecord(env, "100"))!, 1).windowOpenedAt).toBe("x");
  });

  it("shuts once auditions have closed, and sends them to a director", async () => {
    const { env } = envWith();
    const shut = new Date("2027-02-01T00:00:00Z");
    const result = await register(env, "100", "Ada", "new", undefined, TIMELINE, shut);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/Ask a director/);
  });

  it("still answers someone already on the list after the close", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    const shut = new Date("2027-02-01T00:00:00Z");
    expect((await register(env, "100", "Ada", "new", undefined, TIMELINE, shut)).ok).toBe(true);
  });

  it("brings someone back if they withdrew and changed their mind", async () => {
    const { env } = envWith();
    await register(env, "100", "Ada", "new", undefined, TIMELINE, OPEN);
    await withdraw(env, "100");
    expect((await getRecord(env, "100"))?.withdrawnAt).toBeTruthy();
    await register(env, "100", "Ada", "new", undefined, TIMELINE, OPEN);
    expect((await getRecord(env, "100"))?.withdrawnAt).toBeUndefined();
  });
});

describe("Round 0 is not a window", () => {
  it("takes a submission at any point while auditions are open", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    const result = await submit(env, "100", 0, "https://a", TIMELINE, POLICY, OPEN);
    expect(result.ok).toBe(true);
  });

  it("lets someone replace what they already sent", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ rounds: { 0: { submittedAt: "x", submissionUrl: "https://a" } } })),
      ]),
    );
    const result = await submit(env, "100", 0, "https://b", TIMELINE, POLICY, OPEN);
    expect(result.ok).toBe(true);
    expect(roundOf((await getRecord(env, "100"))!, 0).submissionUrl).toBe("https://b");
  });

  it("has nothing for a returning Diamond to submit", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer({ cohort: "returning" }))]));
    const result = await submit(env, "100", 0, "https://a", TIMELINE, POLICY, OPEN);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/nothing to submit/);
  });

  it("refuses something that isn't a link", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    expect(
      (await submit(env, "100", 0, "my google drive", TIMELINE, POLICY, OPEN)).ok,
    ).toBe(false);
  });

  /**
   * No fixed Round 0 deadline any more — the panel names the derived point past
   * which three rounds no longer fit, and says going sooner is easier.
   */
  it("says there's no deadline, and names the date that does matter", () => {
    const panel = roundPanel(dancer(), 0, CTX, OPEN);
    expect(panel.content).toMatch(/no fixed deadline/i);
    // The derived cliff, rendered as a Discord timestamp: end of DEC 22 local,
    // the close date minus the 19 days three rounds still need.
    const cliff = Math.floor(new Date(lastRound0At(TIMELINE, POLICY)).getTime() / 1000);
    expect(panel.content).toContain(`<t:${cliff}:D>`);
  });

  it("switches to a warning once the room has gone", () => {
    const panel = roundPanel(dancer(), 0, CTX, new Date("2026-12-30T00:00:00Z"));
    expect(panel.content).toMatch(/three rounds no longer fit/);
    expect(panel.content).toMatch(/welcome to submit anyway/);
  });

  it("promises the review turnaround once they've submitted", () => {
    const record = dancer({ rounds: { 0: { submittedAt: OPEN.toISOString() } } });
    expect(roundPanel(record, 0, CTX, OPEN).content).toMatch(/within \*\*1–5 days\*\*/);
  });
});

describe("waiting on a director", () => {
  /**
   * The wait between rounds is invisible under rolling rounds unless something
   * says how long it is, and an invisible wait is what people actually complain
   * about.
   */
  it("says who they're waiting on and for how long", () => {
    const record = dancer({
      document: feedbackSent(OPEN.toISOString()),
      rounds: { 0: { submittedAt: OPEN.toISOString() } },
    });
    const panel = roundPanel(record, 1, CTX, OPEN);
    expect(panel.content).toMatch(/Waiting on us/);
    expect(panel.content).toMatch(/\*\*1–5 days\*\*/);
    expect(panel.components).toBeUndefined();
  });
});

describe("starting a window", () => {
  const assigned = (over: Record<string, unknown> = {}) =>
    dancer({
      rounds: {
        2: { assignedPiece: "https://piece", assignedAt: "2026-12-01T00:00:00.000Z", ...over },
        1: { submittedAt: "2026-11-30T00:00:00.000Z" },
      },
    });
  const now = new Date("2026-12-02T12:00:00Z");

  it("reveals the piece and starts the clock in one write", async () => {
    const { env } = envWith(Object.fromEntries([seed(assigned())]));
    const result = await startWindow(env, "100", 2, TIMELINE, POLICY, now);
    expect(result.ok).toBe(true);
    expect(result.ok && roundOf(result.record, 2).windowOpenedAt).toBe(now.toISOString());
    expect(result.ok && roundPanel(result.record, 2, CTX, now).content).toContain("https://piece");
  });

  it("shows nothing but the warning before it's pressed", () => {
    const panel = roundPanel(assigned(), 2, CTX, now);
    expect(panel.content).not.toContain("https://piece");
    expect(panel.content).toMatch(/no way to un-press it/);
    expect(panel.components).toBeTruthy();
  });

  it("refuses a second press rather than resetting the clock", async () => {
    const { env } = envWith(Object.fromEntries([seed(assigned())]));
    await startWindow(env, "100", 2, TIMELINE, POLICY, now);
    const again = await startWindow(
      env,
      "100",
      2,
      TIMELINE,
      POLICY,
      new Date("2026-12-03T12:00:00Z"),
    );
    expect(again.ok).toBe(false);
    expect(roundOf((await getRecord(env, "100"))!, 2).windowOpenedAt).toBe(now.toISOString());
  });

  it("refuses a start too late to shut before auditions close", async () => {
    const { env } = envWith(Object.fromEntries([seed(assigned())]));
    const result = await startWindow(
      env,
      "100",
      2,
      TIMELINE,
      POLICY,
      new Date("2027-01-09T12:00:00Z"),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/wouldn't shut before/);
  });

  /** Round 1 only, and the panel reads as good news rather than a refusal. */
  /**
   * The whole ordering, end to end: a cover, feedback, a piece, a start. The
   * feedback is the gate, so the piece can't even be put up before it.
   */
  it("runs cover -> score -> feedback -> piece -> start, in that order", async () => {
    const { env } = envWith();
    const joined = new Date("2026-11-16T10:00:00Z");
    await register(env, "100", "Ada", "new", undefined, TIMELINE, joined);
    await submit(env, "100", 0, "https://cover", TIMELINE, POLICY, joined);

    const doc = {
      content: "Good cover.",
      strengths: ["clean lines", "good pockets", "committed"],
      growthAreas: ["arms"],
    };

    // The document can be written before Round 0 has been called — it waits,
    // because the verdict travels out inside it.
    const held = await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, joined);
    expect(held.ok).toBe(true);
    expect(held.ok && held.warning).toMatch(/held/);
    expect((await getRecord(env, "100"))?.document?.deliveredAt).toBeUndefined();

    const reviewed = new Date("2026-11-18T10:00:00Z");
    await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, reviewed);
    const second = await scoreRound(env, "100", "d2", { verdict: "pass" }, POLICY, reviewed);
    expect(second.ok && second.settled?.outcome).toBe("passed");

    // The second verdict is what releases the held document, so Round 1 opens
    // without anyone having to remember to file it again.
    expect(second.ok && second.record.document?.deliveredAt).toBe(reviewed.toISOString());

    expect(
      (await assignPiece(env, "100", 1, "https://piece", TARGET, TIMELINE, POLICY, reviewed)).ok,
    ).toBe(true);
    expect(
      (await startWindow(env, "100", 1, TIMELINE, POLICY, new Date("2026-11-18T11:00:00Z"))).ok,
    ).toBe(true);
  });
});

describe("putting a piece up", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  /** Feedback already out, which is what Round 1's piece depends on. */
  const briefed = (over: Partial<DiamondsRecord> = {}) =>
    dancer({
      document: feedbackSent(),
      rounds: { 0: { submittedAt: "2026-11-16T00:00:00.000Z" } },
      ...over,
    });

  it("DMs the dancer, because self-serve needs them to know it's there", async () => {
    const { env } = envWith(Object.fromEntries([seed(briefed())]));
    const result = await assignPiece(env, "100", 1, "https://piece", TARGET, TIMELINE, POLICY, now);
    expect(result.ok).toBe(true);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  /** The Round 1 gap counts from here, so the assignment has to timestamp itself. */
  it("records when it went up", async () => {
    const { env } = envWith(Object.fromEntries([seed(briefed())]));
    await assignPiece(env, "100", 1, "https://piece", TARGET, TIMELINE, POLICY, now);
    expect(roundOf((await getRecord(env, "100"))!, 1).assignedAt).toBe(now.toISOString());
  });

  it("says so when the DM didn't land, rather than reporting success", async () => {
    sendDirectMessage.mockResolvedValueOnce(false);
    const { env } = envWith(Object.fromEntries([seed(briefed())]));
    const result = await assignPiece(env, "100", 1, "https://piece", TARGET, TIMELINE, POLICY, now);
    expect(result.ok && result.warning).toMatch(/DMs are closed/);
  });

  it("refuses to swap a piece out from under someone mid-window", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          briefed({
            rounds: {
              0: { submittedAt: "2026-11-16T00:00:00.000Z" },
              1: { assignedPiece: "https://a", windowOpenedAt: "x" },
            },
          }),
        ),
      ]),
    );
    const result = await assignPiece(env, "100", 1, "https://b", TARGET, TIMELINE, POLICY, now);
    expect(result.ok).toBe(false);
    expect(roundOf((await getRecord(env, "100"))!, 1).assignedPiece).toBe("https://a");
  });
});

/**
 * Round 2's single piece. This is also the path taken if the piece ever gets
 * out, which is why "everyone who hasn't started" is the set it acts on: the
 * people to leave alone are exactly the ones who did nothing wrong.
 */
describe("one piece to everyone", () => {
  const now = new Date("2026-12-22T12:00:00Z");

  const cohort = () =>
    Object.fromEntries([
      seed(dancer({ discordId: "1", rounds: { 1: { outcome: "advanced" } } })),
      seed(
        dancer({
          discordId: "2",
          rounds: {
            1: { outcome: "advanced" },
            2: { assignedPiece: "https://old", windowOpenedAt: "x" },
          },
        }),
      ),
      seed(
        dancer({
          discordId: "3",
          rounds: {
            1: { outcome: "advanced" },
            2: { assignedPiece: "https://old", submittedAt: "x" },
          },
        }),
      ),
      seed(dancer({ discordId: "4", rounds: { 1: { outcome: "practice" } } })),
      seed(dancer({ discordId: "5", withdrawnAt: "x", rounds: { 1: { outcome: "advanced" } } })),
    ]);

  it("reaches only the people who haven't started", async () => {
    const { env } = envWith(cohort());
    const { assigned, skipped } = await assignToAll(env, 2, "https://final", TIMELINE, POLICY, now);
    expect(assigned).toEqual(["1"]);
    expect(skipped.sort()).toEqual(["2", "3", "4"]);
  });

  it("leaves a running window's piece exactly as it was", async () => {
    const { env } = envWith(cohort());
    await assignToAll(env, 2, "https://final", TIMELINE, POLICY, now);
    expect(roundOf((await getRecord(env, "2"))!, 2).assignedPiece).toBe("https://old");
    expect(roundOf((await getRecord(env, "3"))!, 2).assignedPiece).toBe("https://old");
  });

  it("names whoever couldn't be reached", async () => {
    sendDirectMessage.mockResolvedValueOnce(false);
    const { env } = envWith(cohort());
    const { unreachable } = await assignToAll(env, 2, "https://final", TIMELINE, POLICY, now);
    expect(unreachable).toEqual(["1"]);
  });
});

describe("extensions", () => {
  it("move the close time and let the reminder fire again against the new one", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              1: {
                assignedPiece: "https://p",
                windowOpenedAt: "2026-11-24T12:00:00.000Z",
                remindedAt: "2026-11-26T12:00:00.000Z",
              },
            },
          }),
        ),
      ]),
    );
    const result = await grantExtension(env, "100", 1, 2, "sprained an ankle", "d1", POLICY);
    expect(result.ok).toBe(true);
    const entry = roundOf((await getRecord(env, "100"))!, 1);
    expect(entry.extension?.days).toBe(2);
    expect(entry.remindedAt).toBeUndefined();
  });

  it("won't extend a window nobody opened, and says what to do instead", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ rounds: { 1: { assignedPiece: "https://p" } } }))]),
    );
    const result = await grantExtension(env, "100", 1, 2, "nothing yet", "d1", POLICY);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no window to\s+extend/);
  });
});

describe("the daily sweep", () => {

  it("reminds an open window once, a day out", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              1: { assignedPiece: "https://p", windowOpenedAt: "2026-11-24T12:00:00.000Z" },
            },
          }),
        ),
      ]),
    );
    const now = new Date("2026-11-27T00:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, now)).toEqual({ ...quiet, reminded: 1 });
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, now)).toEqual(quiet);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * The heads-up counts from when their own window became startable, not from
   * the cliff — under rolling rounds the cliff can be two months off, and a
   * nudge pegged to it would let someone sit on a piece for seven weeks in
   * silence.
   */
  it("nudges someone sitting on a piece, counted from when it went up", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            document: feedbackSent(),
            rounds: {
              0: { submittedAt: "2026-11-16T00:00:00.000Z" },
              1: { assignedPiece: "https://p", assignedAt: "2026-11-20T00:00:00.000Z" },
            },
          }),
        ),
      ]),
    );
    // Ten days after the piece went up, not ten days before January — the close
    // date is seven weeks off and a nudge pegged to it would say nothing until
    // then.
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-11-28T00:00:00Z")),
    ).toEqual(quiet);

    const due = new Date("2026-12-01T00:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, due)).toEqual({ ...quiet, headsUp: 1 });
    const sent = sendDirectMessage.mock.calls[0]![2];
    expect(sent.content!).toMatch(/waiting 10/);
    // It must not spoil the reveal it's nudging them towards.
    expect(sent.content!).not.toContain("https://p");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, due)).toEqual(quiet);
  });

  it("warns once near the cliff, and not twice in one morning", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              2: { assignedPiece: "https://p", assignedAt: "2027-01-05T00:00:00.000Z" },
              1: { submittedAt: "2027-01-04T00:00:00.000Z" },
            },
          }),
        ),
      ]),
    );
    // Assigned two days before the last start date: the heads-up's lead has not
    // been reached and the last chance has, so exactly one goes out.
    const now = new Date("2027-01-06T00:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, now)).toEqual({ ...quiet, nudged: 1 });
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/last chance/i);
  });

  /**
   * The one nobody else can reach: registered, never submitted, no window to
   * key off and no piece to wait on.
   */
  it("nudges a registration that never became a Round 0", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-12-10T00:00:00Z")),
    ).toEqual(quiet);

    // Three days before the derived cliff, which is DEC 25 local.
    const due = new Date("2026-12-24T00:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, due)).toEqual({ ...quiet, round0: 1 });
    expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/haven't sent your Round 0/);
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, due)).toEqual(quiet);
  });

  it("leaves a returning Diamond out of the Round 0 nudge — they owe nothing", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer({ cohort: "returning" }))]));
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-12-24T00:00:00Z")),
    ).toEqual(quiet);
  });

  it("says nothing to someone with no piece up — that's a director's problem", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ rounds: { 0: { submittedAt: "x" } } }))]),
    );
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-12-10T00:00:00Z")),
    ).toEqual(quiet);
  });

  it("leaves anyone who withdrew alone", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            withdrawnAt: "x",
            rounds: {
              1: { assignedPiece: "https://p", windowOpenedAt: "2026-11-24T12:00:00.000Z" },
            },
          }),
        ),
      ]),
    );
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-11-27T00:00:00Z")),
    ).toEqual(quiet);
  });

  /** One message per person per run, whatever else is true of their record. */
  it("never sends two things to one person in one run", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              1: { assignedPiece: "https://a", windowOpenedAt: "2026-12-20T12:00:00.000Z" },
              2: { assignedPiece: "https://b", windowOpenedAt: "2026-12-20T12:00:00.000Z" },
            },
          }),
        ),
      ]),
    );
    const now = new Date("2026-12-23T00:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, now)).toEqual({ ...quiet, reminded: 1 });
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
  });
});

describe("a late entry", () => {
  const shut = new Date("2027-02-01T00:00:00Z");

  /**
   * The companion to registration refusing late. Refusing is right — the
   * command shouldn't decide whether someone skips what everyone else did — but
   * a refusal pointing at a director needs a director to have a way to act, or
   * it's a dead end with better manners.
   */
  it("goes on the list regardless of the date, and gets told", async () => {
    const { env } = envWith();
    expect((await addEntry(env, "100", "new", 0, TIMELINE, POLICY, shut)).ok).toBe(true);
    expect((await getRecord(env, "100"))?.cohort).toBe("new");
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the rounds of someone already on the list", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ withdrawnAt: "x", rounds: { 0: { submittedAt: "y" } } })),
      ]),
    );
    await addEntry(env, "100", "returning", 1, TIMELINE, POLICY, shut);
    const record = (await getRecord(env, "100"))!;
    expect(record.withdrawnAt).toBeUndefined();
    expect(record.cohort).toBe("returning");
    expect(roundOf(record, 0).submittedAt).toBe("y");
  });
});

describe("the Round 1 target", () => {
  const doc = {
    content: "A good season.",
    strengths: ["held the front line", "learned fast", "showed up"],
    growthAreas: ["arms"],
  };

  /** Both of them, set by the same act that picks the piece. */
  it("is fixed when the piece goes up, in the director's own words", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ cohort: "returning", document: feedbackSent(), rounds: { 0: zeroPassed() } })),
      ]),
    );
    const result = await assignPiece(env, "100", 1, "https://p", TARGET, TIMELINE, POLICY, OPEN);
    expect(result.ok).toBe(true);
    const record = (await getRecord(env, "100"))!;
    expect(record.target).toBe("elbows collapse on extensions");
    expect(record.targetBefore).toBe(4);
    expect(record.targetFixedAt).toBe(OPEN.toISOString());
  });

  /**
   * The piece without the pair is a round with nothing to measure, so it is
   * refused rather than assigned and patched up later — by then the dancer has
   * the piece and any number you pick has seen what they did with it.
   */
  it("refuses a Round 1 piece with no target or no starting number", async () => {
    const seeded = () =>
      envWith(
        Object.fromEntries([
          seed(
            dancer({ cohort: "returning", document: feedbackSent(), rounds: { 0: zeroPassed() } }),
          ),
        ]),
      ).env;

    for (const half of [
      { note: "weak arms", before: undefined },
      { note: undefined, before: 4 },
      { note: "   ", before: 4 },
    ]) {
      const env = seeded();
      const result = await assignPiece(env, "100", 1, "https://p", half, TIMELINE, POLICY, OPEN);
      expect(result.ok).toBe(false);
      expect(roundOf((await getRecord(env, "100"))!, 1).assignedPiece).toBeUndefined();
    }
  });

  /** Moving it after the fact is moving the goalposts, whichever way it goes. */
  it("refuses to re-fix a target that's already set", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            ...sealed,
            document: feedbackSent(),
            rounds: { 0: zeroPassed(), 1: { assignedPiece: "https://p" } },
          }),
        ),
      ]),
    );
    const result = await assignPiece(
      env,
      "100",
      1,
      "https://q",
      { note: "poor timing", before: 2 },
      TIMELINE,
      POLICY,
      OPEN,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/can't be changed/);
    expect((await getRecord(env, "100"))?.target).toBe("elbows collapse on extensions");
  });

  /** And the panel says plainly that this round isn't scored like Round 2. */
  it("reaches the dancer on their Round 1 panel, with the number it starts from", () => {
    const record = dancer({
      target: "timing drifts late in the second eight",
      targetBefore: 4,
      rounds: {
        0: zeroPassed(),
        1: { assignedPiece: "https://p", windowOpenedAt: "2026-11-24T12:00:00.000Z" },
      },
    });
    const panel = roundPanel(record, 1, CTX, new Date("2026-11-25T12:00:00Z"));
    expect(panel.content).toContain("timing drifts late in the second eight");
    expect(panel.content).toMatch(/4\.0\/10/);
    expect(panel.content).toMatch(/Round 2 scores the four dimensions/);
  });

  /** A document that didn't arrive hasn't opened anything. */
  it("only opens Round 1 once the feedback has actually reached them", async () => {
    sendDirectMessage.mockResolvedValueOnce(false);
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ cohort: "returning", rounds: { 0: bothPass() } }))]),
    );
    const result = await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    expect(result.ok && result.warning).toMatch(/undelivered/);
    expect((await getRecord(env, "100"))?.document?.deliveredAt).toBeUndefined();
    // And Round 0 stays open, because its result is that same message.
    expect(roundOf((await getRecord(env, "100"))!, 0).resultSentAt).toBeUndefined();
  });
});

describe("the director's readout", () => {
  const now = new Date("2026-11-27T00:00:00Z");

  /**
   * Nobody shares a round any more, so the only useful sort is by who is
   * waiting on a director.
   */
  it("separates what a director owes from what the dancers owe", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            discordId: "1",
            displayName: "Zoe",
            ...sealed,
            document: feedbackSent(),
            rounds: {
              0: zeroPassed(),
              1: { assignedPiece: "p", assignedAt: "2026-11-18T00:00:00.000Z" },
            },
          }),
        ),
        seed(
          dancer({ discordId: "2", displayName: "Ada", rounds: { 0: { submittedAt: "x" } } }),
        ),
        seed(dancer({ discordId: "3", displayName: "Bo" })),
      ]),
    );
    const readout = rosterReadout(await allRecords(env), CTX, now);

    // Only 2 is waiting on a director — they've sent a cover and owe nothing.
    // 3 hasn't filmed one yet, which is the opposite, and is what a
    // `windowState`-only sort got wrong: Round 0 never has an assigned piece.
    expect(readout.content).toMatch(/1 waiting on you/);
    const [ours, theirs] = readout.content!.split("with them");
    expect(ours).toContain("<@2>");
    expect(theirs).toContain("<@3>");
    expect(theirs).toContain("<@1>");
  });

  it("counts a returning Diamond's undecided Round 0 as the director's move", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ discordId: "1", cohort: "returning" }))]),
    );
    const readout = rosterReadout(await allRecords(env), CTX, now);
    expect(readout.content).toMatch(/1 waiting on you/);
    // Both halves, because both are missing and either one blocks it.
    expect(readout.content).toMatch(/needs a pass\/fail \+ feedback written/);
  });

  /** Written already: now the only thing left is the call itself. */
  it("drops the written half of the note once the document exists", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            discordId: "1",
            cohort: "returning",
            document: { ...feedbackSent(), deliveredAt: undefined },
          }),
        ),
      ]),
    );
    const readout = rosterReadout(await allRecords(env), CTX, now);
    expect(readout.content).toMatch(/needs a pass\/fail/);
    expect(readout.content).not.toMatch(/feedback written/);
  });

  /**
   * The failure DIAMONDS.md warns about: a round on one ballot against a
   * threshold of two, settling never, and nothing surfacing it.
   */
  it("surfaces a round stuck on one ballot", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            discordId: "1",
            ...sealed,
            document: feedbackSent(),
            rounds: {
              0: zeroPassed(),
              1: { submittedAt: "y", ballots: { d1: { targetScore: 6, at: "z" } } },
            },
          }),
        ),
      ]),
    );
    const readout = rosterReadout(await allRecords(env), CTX, now);
    expect(readout.content).toMatch(/1 of 2 ballots/);
    expect(readout.content).toMatch(/waiting on another director/);
  });

  it("shows the estimate for whichever round they're in", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ rounds: { 0: { plannedStartAt: "2026-11-29" } } })),
        seed(
          dancer({
            discordId: "200",
            ...sealed,
            document: feedbackSent(),
            rounds: {
              0: { ...zeroPassed(), plannedStartAt: "2026-11-20" },
              1: {
                assignedPiece: "p",
                assignedAt: "2026-11-18T00:00:00.000Z",
                plannedStartAt: "2026-12-02",
              },
            },
          }),
        ),
      ]),
    );
    const readout = rosterReadout(await allRecords(env), CTX, now);
    expect(readout.content).toContain("plans 2026-11-29");
    // Round 1's estimate, not the stale Round 0 one.
    expect(readout.content).toContain("plans 2026-12-02");
    expect(readout.content).not.toContain("plans 2026-11-20");
  });

  it("puts a newcomer who owes a cover on the other side from a Round 0 we owe", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ discordId: "1", cohort: "returning" })),
        seed(dancer({ discordId: "2", cohort: "new" })),
      ]),
    );
    const readout = rosterReadout(await allRecords(env), CTX, now);
    const [ours, theirs] = readout.content!.split("with them");
    expect(ours).toMatch(/<@1>[^\n]*needs a pass\/fail/);
    // The newcomer owes a cover, not a decision, and sits on the other side.
    expect(theirs).toMatch(/<@2>[^\n]*no Round 0 cover yet/);
  });

  it("says plainly when nobody has registered", () => {
    expect(rosterReadout([], CTX, now).content).toMatch(/nobody registered/);
  });
});

describe("status", () => {
  it("names no per-round dates, because there aren't any", () => {
    const panel = statusPanel(dancer(), 0, CTX, OPEN);
    expect(panel.content).toMatch(/Where everything stands/);
    expect(panel.content).toMatch(/Everything shuts/);
    // The end-to-end estimate, so nobody has to add it up themselves.
    expect(panel.content).toMatch(/16 days/);
  });
});

describe("the start button's custom id", () => {
  it("round-trips", () => {
    expect(parseDiamondsCustomId("dia|start|1")).toEqual({ action: "start", arg: "1" });
    expect(parseDiamondsCustomId("dia|doc-save|100")).toEqual({
      action: "doc-save",
      arg: "100",
    });
  });

  it("refuses anything else", () => {
    for (const junk of ["", "dia|start", "aud|start|1", "dia|nope|1", "dia|start|../../x"]) {
      expect(parseDiamondsCustomId(junk)).toBeNull();
    }
  });
});

/**
 * The estimate. Per round, because each round is a separate decision about
 * when to find three days — and because an estimate guessed in November about a
 * round reached in December is not a plan.
 */
describe("saying when you'll start", () => {
  /** Piece up NOV 28, so the ten-day heads-up isn't due until DEC 8. */
  const assigned = (over: Record<string, unknown> = {}) =>
    dancer({
      registeredAt: "2026-11-16T00:00:00.000Z",
      document: feedbackSent("2026-11-27T00:00:00.000Z"),
      rounds: {
        0: { submittedAt: "2026-11-16T00:00:00.000Z" },
        1: { assignedPiece: "https://p", assignedAt: "2026-11-28T00:00:00.000Z", ...over },
      },
    });
  const now = new Date("2026-11-28T09:00:00Z");

  it("records a day and says it can move", async () => {
    const { env } = envWith(Object.fromEntries([seed(assigned())]));
    const result = await planStart(env, "100", 1, "2026-12-02", TIMELINE, POLICY, now);
    expect(result.ok).toBe(true);
    expect(roundOf((await getRecord(env, "100"))!, 1).plannedStartAt).toBe("2026-12-02");
  });

  /**
   * Validated rather than trusted: a plan the bot can't honour is worse than no
   * plan, because they'd be waiting for a reminder on a day they were never able
   * to start.
   */
  it("refuses a day they couldn't start on", async () => {
    const { env } = envWith(Object.fromEntries([seed(assigned())]));

    // Past the one shared cliff.
    const late = await planStart(env, "100", 1, "2027-01-09", TIMELINE, POLICY, now);
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.reason).toMatch(/wouldn't shut/);

    const gone = await planStart(env, "100", 1, "2026-11-20", TIMELINE, POLICY, now);
    expect(gone.ok).toBe(false);
    expect(gone.ok === false && gone.reason).toMatch(/already gone/);

    expect((await planStart(env, "100", 1, "the 2nd", TIMELINE, POLICY, now)).ok).toBe(false);
  });

  it("reminds them that morning, once", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(assigned({ plannedStartAt: "2026-12-02" }))]),
    );
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-12-01T09:00:00Z")),
    ).toEqual(quiet);

    const theDay = new Date("2026-12-02T09:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, theDay)).toEqual({
      ...quiet,
      planned: 1,
    });
    const sent = sendDirectMessage.mock.calls[0]![2];
    expect(sent.content!).toMatch(/you said you'd start/i);
    expect(sent.content!).toMatch(/No obligation/);
    // Still must not spoil the reveal it's nudging them towards.
    expect(sent.content!).not.toContain("https://p");

    expect(await runDiamondsSweep(env, TIMELINE, POLICY, theDay)).toEqual(quiet);
  });

  /** Due *on* the day: a sweep that missed it stays quiet rather than running late. */
  it("doesn't say it two days late", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(assigned({ plannedStartAt: "2026-12-02" }))]),
    );
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-12-04T09:00:00Z")),
    ).toEqual(quiet);
  });

  it("moves the reminder when they move the date", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          assigned({
            plannedStartAt: "2026-12-02",
            plannedRemindedAt: "2026-12-02T09:00:00.000Z",
          }),
        ),
      ]),
    );
    await planStart(env, "100", 1, "2026-12-09", TIMELINE, POLICY, now);
    const entry = roundOf((await getRecord(env, "100"))!, 1);
    expect(entry.plannedRemindedAt).toBeUndefined();
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-12-09T09:00:00Z")),
    ).toEqual({ ...quiet, planned: 1 });
  });

  it("says nothing once they've started", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          assigned({
            plannedStartAt: "2026-12-02",
            windowOpenedAt: "2026-12-01T09:00:00.000Z",
          }),
        ),
      ]),
    );
    const result = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-12-02T09:00:00Z"));
    expect(result.planned).toBe(0);
  });

  it("asks for one on the panel, and shows it once set", () => {
    const blank = roundPanel(assigned(), 1, CTX, now);
    expect(blank.content).toMatch(/Pick a day you'll start/);

    const set = roundPanel(assigned({ plannedStartAt: "2026-12-02" }), 1, CTX, now);
    expect(set.content).toMatch(/You said around 2026-12-02/);
    expect(set.content).toMatch(/nothing happens if it slips/);
  });
});

/**
 * One feedback path for both cohorts. The cohort decides only whether a cover
 * has to come first — not who gets feedback, and not what opens Round 1.
 */
describe("feedback, for either cohort", () => {
  const doc = {
    content: "A good cover.",
    strengths: ["clean lines", "good pockets", "committed"],
    growthAreas: ["arms"],
  };

  it("refuses a newcomer who hasn't sent a cover — there's nothing to write against", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    const result = await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/hasn't submitted a Round 0 cover/);
  });

  it("takes one for a newcomer who has", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ rounds: { 0: { submittedAt: "x" } } }))]),
    );
    expect((await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN)).ok).toBe(
      true,
    );
  });

  it("takes one for a returning Diamond who has sent nothing", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer({ cohort: "returning" }))]));
    expect((await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN)).ok).toBe(
      true,
    );
  });

  /** Delivery is the gate, so an undelivered one must not open anything. */
  it("leaves them in Round 0 when the DM fails, and says so", async () => {
    sendDirectMessage.mockResolvedValueOnce(false);
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ cohort: "returning", rounds: { 0: bothPass() } }))]),
    );
    const result = await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    expect(result.ok && result.warning).toMatch(/has \*\*not\*\* opened/);
    const record = (await getRecord(env, "100"))!;
    expect(record.document?.deliveredAt).toBeUndefined();
    expect(activeRound(record, OPEN)).toEqual({ ok: true, round: 0 });
  });

  /**
   * The verdict and the reasons as one message, in that order — the reasons
   * first, because they are the part that's worth something either way.
   */
  it("carries a pass out with the feedback, and opens Round 1", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ cohort: "returning", rounds: { 0: bothPass() } }))]),
    );
    await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    const sent = sendDirectMessage.mock.calls[0]![2].content!;
    expect(sent).toMatch(/through to Round 1/);
    expect(sent).toContain("clean lines");
    expect(sent).toMatch(/clock doesn't run until/);
    expect(sent.indexOf("clean lines")).toBeLessThan(sent.indexOf("through to Round 1"));

    const record = (await getRecord(env, "100"))!;
    expect(roundOf(record, 0).outcome).toBe("passed");
    expect(roundOf(record, 0).resultSentAt).toBe(OPEN.toISOString());
    expect(activeRound(record, OPEN)).toEqual({ ok: true, round: 1 });
  });

  /** A fail says so, keeps the feedback, and ends the audition rather than opening Round 1. */
  it("carries a fail out the same way, and ends it there", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            cohort: "returning",
            rounds: {
              0: {
                ballots: {
                  d1: { verdict: "fail", at: "x" },
                  d2: { verdict: "fail", at: "x" },
                },
              },
            },
          }),
        ),
      ]),
    );
    await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    const sent = sendDirectMessage.mock.calls[0]![2].content!;
    expect(sent).toMatch(/not taking this one through/);
    expect(sent).toContain("clean lines");

    const record = (await getRecord(env, "100"))!;
    expect(roundOf(record, 0).outcome).toBe("failed");
    expect(activeRound(record, OPEN).ok).toBe(false);
  });

  /**
   * And written before either of them has decided, it waits rather than being
   * refused — which is the normal order, since the moment to write it is while
   * you're watching.
   */
  it("holds a document written before Round 0 was called", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer({ cohort: "returning" }))]));
    const held = await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    expect(held.ok && held.warning).toMatch(/held/);
    expect(sendDirectMessage).not.toHaveBeenCalled();

    await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, OPEN);
    const second = await scoreRound(env, "100", "d2", { verdict: "pass" }, POLICY, OPEN);
    expect(second.ok && second.record.document?.deliveredAt).toBe(OPEN.toISOString());
  });

  /** A split holds it too, and says which way each of them went. */
  it("holds a document while the two of them disagree", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer({ cohort: "returning" }))]));
    await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, OPEN);
    const second = await scoreRound(env, "100", "d2", { verdict: "fail" }, POLICY, OPEN);
    expect(second.ok && second.warning).toMatch(/one of you/);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  /**
   * A newcomer who has sent a cover is owed feedback exactly as much as a
   * returning Diamond — which the roster got wrong when it sided on cohort.
   */
  it("counts a submitted newcomer as waiting on a director", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ discordId: "1", rounds: { 0: { submittedAt: "2026-11-16T00:00:00.000Z" } } })),
        seed(dancer({ discordId: "2" })),
      ]),
    );
    const readout = rosterReadout(await allRecords(env), CTX, new Date("2026-11-18T00:00:00Z"));
    expect(readout.content).toMatch(/1 waiting on you/);
    expect(readout.content).toMatch(/<@1>[^\n]*needs a pass\/fail/);
    expect(readout.content).toMatch(/<@2>[^\n]*no Round 0 cover yet/);
  });
});

describe("scoring, end to end", () => {
  const FOUR = { technicality: 7, execution: 7, performance: 7, musicality: 7 };
  const now = new Date("2026-11-18T10:00:00Z");

  /** Ready for Round 0 to be scored. */
  const waiting = (over: Partial<DiamondsRecord> = {}) =>
    dancer({ rounds: { 0: { submittedAt: "2026-11-16T00:00:00.000Z" } }, ...over });

  it("says only how many ballots are in until the last one lands", async () => {
    const { env } = envWith(Object.fromEntries([seed(waiting())]));
    const first = await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.tally).toEqual({ count: 1, complete: false });
    expect(first.settled).toBeUndefined();

    const receipt = ballotReceipt(first.record, 0, first.tally, first.splits, undefined, POLICY);
    // The seal: a count, and no word of which way the other one is leaning.
    expect(receipt.content).toMatch(/1 of 2/);
    expect(receipt.content).not.toMatch(/pass|fail/i);
  });

  it("settles Round 0 when the second verdict agrees", async () => {
    const { env } = envWith(Object.fromEntries([seed(waiting())]));
    await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, now);
    const second = await scoreRound(env, "100", "d2", { verdict: "pass" }, POLICY, now);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.tally.verdict).toBe("pass");
    expect(second.settled?.outcome).toBe("passed");
    // Nothing numeric comes out of it, and nothing is fixed for Round 1.
    expect(second.record.targetBefore).toBeUndefined();
    expect(second.record.targetFixedAt).toBeUndefined();
  });

  /**
   * One each. There is no majority of two and no mean to take on a decision
   * with two values, so nothing settles — and the receipt has to say that
   * rather than quietly picking one.
   */
  it("reports a pass-and-a-fail as a split and settles nothing", async () => {
    const { env } = envWith(Object.fromEntries([seed(waiting())]));
    await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, now);
    const second = await scoreRound(env, "100", "d2", { verdict: "fail" }, POLICY, now);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.tally.verdict).toBe("split");
    expect(second.settled).toBeUndefined();
    expect(roundOf(second.record, 0).resultSentAt).toBeUndefined();

    const receipt = ballotReceipt(second.record, 0, second.tally, second.splits, undefined, POLICY);
    expect(receipt.content).toMatch(/One pass, one fail/);
  });

  it("lets a director change their mind rather than accumulating ballots", async () => {
    const { env } = envWith(Object.fromEntries([seed(waiting())]));
    await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, now);
    const again = await scoreRound(env, "100", "d1", { verdict: "fail" }, POLICY, now);
    expect(again.ok && again.tally.count).toBe(1);
  });

  /** Round 0 takes no numbers, and says so rather than silently ignoring them. */
  it("refuses a ballot that's missing what its round needs", async () => {
    const { env } = envWith(Object.fromEntries([seed(waiting())]));
    const scored = await scoreRound(env, "100", "d1", { scores: FOUR, targetScore: 4 }, POLICY, now);
    expect(scored.ok).toBe(false);
    expect(scored.ok === false && scored.reason).toMatch(/pass or a fail/);
  });

  /** The whole point of the delta: before and after on the one named thing. */
  it("settles Round 1 on the delta and sends the result once", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            ...sealed,
            document: feedbackSent(),
            rounds: {
              0: zeroPassed(),
              1: { assignedPiece: "p", submittedAt: "2026-12-01T00:00:00.000Z" },
            },
          }),
        ),
      ]),
    );
    await scoreRound(env, "100", "d1", { targetScore: 6 }, POLICY, now);
    const both = await scoreRound(env, "100", "d2", { targetScore: 6.5 }, POLICY, now);
    expect(both.ok && both.round).toBe(1);
    expect(both.ok && both.settled?.outcome).toBe("advanced");
    // 4 before, 6.25 after — 1.8 anchor steps.
    expect(both.ok && both.settled?.advancement?.steps).toBeCloseTo(1.8);

    sendDirectMessage.mockClear();
    const sent = await sendResult(env, "100", DIRECTORS, CTX, POLICY, now);
    expect(sent.ok).toBe(true);
    expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/through to Round 2/);

    const entry = roundOf((await getRecord(env, "100"))!, 1);
    expect(entry.outcome).toBe("advanced");
    expect(entry.resultSentAt).toBe(now.toISOString());

    // And it can't go twice.
    expect((await sendResult(env, "100", DIRECTORS, CTX, POLICY, now)).ok).toBe(false);
  });

  /**
   * A result marked sent that never arrived is the worst of both, so nothing is
   * recorded unless the DM landed.
   */
  it("records nothing when the result DM fails", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            ...sealed,
            document: feedbackSent(),
            rounds: {
              0: zeroPassed(),
              1: {
                submittedAt: "x",
                ballots: { d1: { targetScore: 7, at: "x" }, d2: { targetScore: 7, at: "x" } },
              },
            },
          }),
        ),
      ]),
    );
    sendDirectMessage.mockResolvedValueOnce(false);
    const result = await sendResult(env, "100", DIRECTORS, CTX, POLICY, now);
    expect(result.ok).toBe(false);
    expect(roundOf((await getRecord(env, "100"))!, 1).resultSentAt).toBeUndefined();
  });

  it("won't send a result that isn't settled yet", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            ...sealed,
            document: feedbackSent(),
            rounds: {
              0: zeroPassed(),
              1: { submittedAt: "x", ballots: { d1: { targetScore: 7, at: "x" } } },
            },
          }),
        ),
      ]),
    );
    const result = await sendResult(env, "100", DIRECTORS, CTX, POLICY, now);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/1 of 2/);
  });

  it("has no result to send for Round 0, and says what goes out instead", async () => {
    const { env } = envWith(Object.fromEntries([seed(waiting())]));
    const result = await sendResult(env, "100", DIRECTORS, CTX, POLICY, now);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/diamonds feedback/);
  });

  it("refuses to score someone with nothing waiting", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    const result = await scoreRound(env, "100", "d1", { scores: FOUR, targetScore: 4 }, POLICY, now);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/Nothing of/);
  });
});

/**
 * Feedback the way rank 12 does it: written whenever suits, sealed until the
 * round settles, and sent with the result.
 */
describe("feedback on a round that ends in a result", () => {
  const now = new Date("2026-12-02T10:00:00Z");

  const submitted = (over: Record<string, unknown> = {}) =>
    dancer({
      ...sealed,
      document: feedbackSent(),
      rounds: {
        0: zeroPassed(),
        1: { assignedPiece: "p", submittedAt: "2026-12-01T00:00:00.000Z", ...over },
      },
    });

  it("takes a note before any ballot, and seals it", async () => {
    const { env } = envWith(Object.fromEntries([seed(submitted())]));
    const result = await noteRound(env, "100", "d1", "Arms much better.", POLICY, now);
    expect(result.ok).toBe(true);
    expect(result.ok && result.round).toBe(1);
    expect(result.sealed).toBe(true);
    expect(roundOf((await getRecord(env, "100"))!, 1).feedback?.d1?.text).toBe(
      "Arms much better.",
    );
  });

  it("takes one after the ballots too, and says it's no longer sealed", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          submitted({
            ballots: { d1: { targetScore: 6, at: "x" }, d2: { targetScore: 6, at: "x" } },
          }),
        ),
      ]),
    );
    const result = await noteRound(env, "100", "d2", "Agreed.", POLICY, now);
    expect(result.ok).toBe(true);
    expect(result.sealed).toBe(false);
  });

  it("replaces a director's note rather than appending to it", async () => {
    const { env } = envWith(Object.fromEntries([seed(submitted())]));
    await noteRound(env, "100", "d1", "first", POLICY, now);
    await noteRound(env, "100", "d1", "second", POLICY, now);
    const written = roundOf((await getRecord(env, "100"))!, 1).feedback!;
    expect(Object.keys(written)).toEqual(["d1"]);
    expect(written.d1?.text).toBe("second");
  });

  /**
   * Tied to settlement rather than to everyone having written: the director
   * sitting this one out never writes, and waiting for them would mean the
   * dancer reads nothing.
   */
  it("reveals on settlement, not on everyone having written", async () => {
    const one = submitted({
      feedback: { d1: { text: "mine", at: "x" } },
      ballots: { d1: { targetScore: 6, at: "x" } },
    });
    expect(feedbackRevealed(one, 1, POLICY)).toBe(false);

    const both = submitted({
      feedback: { d1: { text: "mine", at: "x" } },
      ballots: { d1: { targetScore: 6, at: "x" }, d2: { targetScore: 6, at: "x" } },
    });
    expect(feedbackRevealed(both, 1, POLICY)).toBe(true);
    // One note, two ballots: still revealed.
    expect(composeFeedback(roundOf(both, 1), DIRECTORS)).toBe("mine");
  });

  it("composes the notes in roster order, whoever wrote first", () => {
    const record = submitted({
      feedback: {
        d2: { text: "second director", at: "x" },
        d1: { text: "first director", at: "x" },
      },
    });
    expect(composeFeedback(roundOf(record, 1), DIRECTORS)).toBe(
      "first director\n\nsecond director",
    );
  });

  it("sends the notes with the result, under their own heading", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          submitted({
            feedback: { d1: { text: "Elbows holding now.", at: "x" } },
            ballots: { d1: { targetScore: 6.5, at: "x" }, d2: { targetScore: 6.5, at: "x" } },
          }),
        ),
      ]),
    );
    const sent = await sendResult(env, "100", DIRECTORS, CTX, POLICY, now);
    expect(sent.ok).toBe(true);
    const dm = sendDirectMessage.mock.calls[0]![2].content!;
    expect(dm).toMatch(/What the directors wrote/);
    expect(dm).toContain("Elbows holding now.");
  });

  it("still sends a result nobody wrote anything for", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          submitted({
            ballots: { d1: { targetScore: 6.5, at: "x" }, d2: { targetScore: 6.5, at: "x" } },
          }),
        ),
      ]),
    );
    expect((await sendResult(env, "100", DIRECTORS, CTX, POLICY, now)).ok).toBe(true);
    expect(sendDirectMessage.mock.calls[0]![2].content!).not.toMatch(/directors wrote/);
  });

  it("points Round 0 at its own form instead", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ rounds: { 0: { submittedAt: "x" } } }))]),
    );
    const result = await noteRound(env, "100", "d1", "something", POLICY, now);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/written document/);
  });

  it("shows who has written on the receipt, and not what", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(submitted({ feedback: { d1: { text: "secret so far", at: "x" } } })),
      ]),
    );
    const scored = await scoreRound(env, "100", "d1", { targetScore: 6 }, POLICY, now);
    expect(scored.ok).toBe(true);
    if (!scored.ok) return;
    const receipt = ballotReceipt(scored.record, 1, scored.tally, scored.splits, undefined, POLICY);
    expect(receipt.content).toMatch(/Feedback: 1 written/);
    expect(receipt.content).not.toContain("secret so far");
  });
});
