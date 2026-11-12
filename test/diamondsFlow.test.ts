import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted, because vi.mock's factory is lifted above the imports and cannot
// reach a plain top-level const.
const {
  sendDirectMessage,
  postToChannelByName,
  editMessage,
  alertDirectors,
  removeRole,
  addRole,
  memberRoles,
} =
  vi.hoisted(() => ({
    sendDirectMessage: vi.fn(
      async (
        _env: unknown,
        _userId: string,
        _payload: { content?: string; components?: unknown },
      ): Promise<boolean> => true,
    ),
    postToChannelByName: vi.fn(
      async (
        _env: unknown,
        _guildId: string,
        _name: string,
        _payload: unknown,
      ): Promise<{ id: string; channelId: string }> => ({
        id: "msg1",
        channelId: "chan1",
      }),
    ),
    addRole: vi.fn(
      async (
        _env: unknown,
        _guildId: string,
        _userId: string,
        _roleId: string,
      ): Promise<void> => undefined,
    ),
    memberRoles: vi.fn(
      async (_env: unknown, _guildId: string, _userId: string): Promise<string[] | null> => [],
    ),
    removeRole: vi.fn(
      async (
        _env: unknown,
        _guildId: string,
        _userId: string,
        _roleId: string,
      ): Promise<void> => {},
    ),
    editMessage: vi.fn(
      async (
        _env: unknown,
        _channelId: string,
        _messageId: string,
        _payload: unknown,
      ): Promise<void> => {},
    ),
    alertDirectors: vi.fn(async (_env: unknown, _content: string): Promise<void> => {}),
  }));
vi.mock("../src/discord/rest", () => ({
  sendDirectMessage,
  postToChannelByName,
  editMessage,
  alertDirectors,
  removeRole,
  addRole,
  memberRoles,
}));

import {
  activeRound,
  composeFeedback,
  DEFAULT_WEIGHTS,
  feedbackRevealed,
  roundOf,
  runDaysLeft,
  runEndsAt,
  runExpired,
  settleRound,
  tally,
  type Round,
  type DiamondsRecord,
  type DiamondsTimeline,
} from "../src/diamonds/audition";
import {
  ballotReceipt,
  parseDiamondsCustomId,
  reviewCard,
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
  type DiamondsPolicy,
} from "../src/diamonds/config";
import {
  addEntry,
  allRecords,
  assignPiece,
  assignToAll,
  carryAsPractice,
  extendRun,
  fileFeedback,
  getRecord,
  grantExtension,
  grantMembership,
  noteRound,
  panelContext,
  planStart,
  register,
  runDiamondsSweep,
  scoreRound,
  sendResult,
  startWindow,
  submit,
  takePractice,
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
  return {
    env: {
      KV: kv,
      GUILD_DANCE_ID: "g-dance",
      GUILD_COMMUNITY_ID: "g-community",
      CH_AUDITION_REVIEW: "audition-review",
      CH_DIAMONDS_BOT: "diamonds-bot",
    } as unknown as Env,
    store,
  };
}

/** The custom ids on whatever was last posted or edited, in order. */
const cardButtons = (call: { mock: { calls: unknown[][] } }, index = -1): string[] => {
  const payload = call.mock.calls.at(index)?.at(-1) as {
    components?: { components?: { custom_id?: string }[] }[];
  };
  return (payload.components ?? []).flatMap((row) =>
    (row.components ?? []).map((one) => one.custom_id ?? ""),
  );
};

/** The embed description of whatever was last posted or edited. */
const cardText = (call: { mock: { calls: unknown[][] } }, index = -1): string => {
  const calls = call.mock.calls;
  const payload = calls.at(index)?.at(-1) as {
    embeds?: { description?: string; fields?: { name: string; value: string }[]; footer?: { text: string } }[];
  };
  const embed = payload.embeds?.[0];
  return [
    embed?.description ?? "",
    ...(embed?.fields ?? []).map((f) => `${f.name}: ${f.value}`),
    embed?.footer?.text ?? "",
  ].join("\n");
};

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

/** The announced open date, which is also what the default resolves to. */
const TIMELINE: DiamondsTimeline = {
  opensAt: "2026-11-15T05:01:00.000Z",
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
  noticeDays: [20, 30, 60],
  retryMonths: 6,
  runDays: 60,
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

/** Feedback they were told about *and opened* — the thing that opens Round 1. */
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
const quiet = {
  reminded: 0,
  nudged: 0,
  headsUp: 0,
  round0: 0,
  planned: 0,
  unread: 0,
  warned: 0,
  expired: 0,
  renewals: 0,
  lapsed: 0,
  blocked: 0,
};
/** A Round 0 cover, since registering is sending one. */
const COVER = "https://cover.example/ada";
const OPEN = new Date("2026-11-18T00:00:00Z");
/** The morning after, when they open the document. */
const REVIEWED = new Date("2026-11-19T09:00:00Z");
/** And later still, when they come back to it mid-window. */
const LATER = new Date("2026-11-24T09:00:00Z");

beforeEach(() => {
  sendDirectMessage.mockClear();
  postToChannelByName.mockClear();
  postToChannelByName.mockResolvedValue({ id: "msg1", channelId: "chan1" });
  editMessage.mockClear();
  alertDirectors.mockClear();
  removeRole.mockClear();
  removeRole.mockResolvedValue(undefined);
  addRole.mockClear();
  addRole.mockResolvedValue(undefined);
  // Nobody is a Diamond Director unless a test says so.
  memberRoles.mockClear();
  memberRoles.mockResolvedValue([]);
});

describe("the timeline", () => {
  it("opens at the start of its day", () => {
    // 00:01 in New York, which is what the announcement means by "opens NOV 15".
    expect(resolveTimeline({}, "America/New_York").opensAt).toBe("2026-11-15T05:01:00.000Z");
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
    expect(resolveTimeline({ opensAt: "Nov 15th" }, "America/New_York").opensAt).toBe(
      TIMELINE.opensAt,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("takes an override that is a real date", async () => {
    const { env } = envWith({ "config:diamonds.opens": "2026-11-20" });
    expect((await getDiamondsTimeline(env)).opensAt).toBe("2026-11-20T05:01:00.000Z");
  });

  it("reads the bar from KV so it can move without a deploy", async () => {
    const { env } = envWith({ "config:diamonds_bar": "7.1" });
    const policy = await getDiamondsPolicy(env);
    expect(policy.bar).toBe(7.1);
    expect(policy.floor).toBe(6);
    expect(policy.reviewMinDays).toBe(1);
    expect(policy.reviewMaxDays).toBe(5);
  });

});

describe("setting the timeline before the flag goes on", () => {
  it("writes the date and reads the whole thing back", async () => {
    const { env } = envWith();
    expect((await setDiamondsTimeline(env, { opensAt: "2026-11-20" })).ok).toBe(true);
    const readout = await inspectDiamondsConfig(env);
    expect(readout.timeline.opensAt).toBe("2026-11-20T05:01:00.000Z");
    expect(readout.dateSources.opensAt).toBe("set");
    // And says which values are still whatever the code shipped with, because
    // that is the thing to check against the announcement before turning it on.
    expect(readout.policySources.diamonds_bar).toBe("default");
    expect(readout.enabled).toBe(false);
  });

  it("refuses anything that isn't a date", async () => {
    const { env } = envWith();
    expect((await setDiamondsTimeline(env, { opensAt: "Nov 15th" })).ok).toBe(false);
    expect((await setDiamondsTimeline(env, { opensAt: "2026-13-45" })).ok).toBe(false);
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
    await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, OPEN);
    const second = await register(env, "100", "Ada L", "new", COVER, TIMELINE, POLICY, OPEN);
    expect(second.ok).toBe(true);
    expect(second.ok && second.record.displayName).toBe("Ada L");
    // The cover from the first run stands; the second doesn't replace it.
    expect(second.ok && roundOf(second.record, 0).submittedAt).toBe(OPEN.toISOString());
  });

  /**
   * Registering *is* the Round 0 submission, so there is no longer a gap
   * between putting your name down and sending something — which was the state
   * people went quiet in.
   */
  it("records the cover as the submission", async () => {
    const { env } = envWith();
    const first = await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, OPEN);
    expect(first.ok && roundOf(first.record, 0).submissionUrl).toBe(COVER);
    expect(first.ok && roundOf(first.record, 0).submittedAt).toBe(OPEN.toISOString());
  });

  it("refuses a newcomer with no cover, and says what one is", async () => {
    const { env } = envWith();
    const result = await register(env, "100", "Ada", "new", undefined, TIMELINE, POLICY, OPEN);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/needs a link/);
    expect(result.ok === false && result.reason).toMatch(/last six months/);
  });

  it("refuses something that isn't a link", async () => {
    const { env } = envWith();
    expect(
      (await register(env, "100", "Ada", "new", "my google drive", TIMELINE, POLICY, OPEN)).ok,
    ).toBe(false);
  });

  /** A returning Diamond owes no cover, so they need pass nothing. */
  it("takes a returning Diamond with nothing at all", async () => {
    const { env } = envWith();
    const result = await register(env, "100", "Ada", "returning", undefined, TIMELINE, POLICY, OPEN);
    expect(result.ok).toBe(true);
    expect(result.ok && roundOf(result.record, 0).submittedAt).toBeUndefined();
  });

  it("doesn't touch a round that's already under way", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ rounds: { 1: { assignedPiece: "https://p", windowOpenedAt: "x" } } })),
      ]),
    );
    await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, OPEN);
    expect(roundOf((await getRecord(env, "100"))!, 1).windowOpenedAt).toBe("x");
  });

  /**
   * Registration used to shut on the shared close date. Nothing closes now —
   * membership is enforced per person, so a newcomer in February is just a
   * newcomer, and the only thing that can still turn anyone away is the retry
   * wait after an audition that didn't pass.
   */
  it("takes a newcomer long after the old close date", async () => {
    const { env } = envWith();
    const later = new Date("2027-02-01T00:00:00Z");
    expect((await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, later)).ok).toBe(
      true,
    );
  });

  it("holds someone who withdrew to the wait, same as a failure", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, OPEN);
    await withdraw(env, "100");

    const back = await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, OPEN);
    expect(back.ok).toBe(false);
    expect(back.ok === false && back.reason).toMatch(/6-month wait/);
    expect((await getRecord(env, "100"))?.withdrawnAt).toBeTruthy();
  });
});

/**
 * The directors' end of a submission. `#audition-review` already holds the
 * applicant and trainee videos, so this is one stack to work through rather
 * than a third place to remember to look.
 */
describe("the review card", () => {
  it("posts the video to #audition-review and remembers where it put it", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    await submit(env, "100", 0, "https://cover", TIMELINE, POLICY, OPEN);

    expect(postToChannelByName).toHaveBeenCalledTimes(1);
    const [, guild, channel] = postToChannelByName.mock.calls[0]!;
    expect(guild).toBe("g-community");
    expect(channel).toBe("audition-review");
    expect(cardText(postToChannelByName)).toContain("https://cover");

    const entry = roundOf((await getRecord(env, "100"))!, 0);
    expect(entry.reviewMessageId).toBe("msg1");
    expect(entry.reviewChannelId).toBe("chan1");
  });

  it("says what the round still needs, and where the command works", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    await submit(env, "100", 0, "https://cover", TIMELINE, POLICY, OPEN);
    const text = cardText(postToChannelByName);
    expect(text).toMatch(/Pass or fail/);
    expect(text).toContain("#diamonds-bot");
    expect(text).toMatch(/0 of 2 ballots/);
  });

  /**
   * The card hangs where both directors read it, so it is one more surface the
   * seal has to hold on — a number on it would anchor the second of them
   * exactly as a visible tally in the reply would.
   */
  it("shows a count and never a ballot while the round is open", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: zeroPassed(),
              1: {
                assignedPiece: "https://piece",
                windowOpenedAt: "2026-11-18T00:00:00.000Z",
                reviewMessageId: "msg1",
                reviewChannelId: "chan1",
              },
            },
            ...sealed,
            document: feedbackSent(),
          }),
        ),
      ]),
    );
    await submit(env, "100", 1, "https://after", TIMELINE, POLICY, OPEN);
    await scoreRound(env, "100", "d1", { targetScore: 8 }, POLICY, OPEN);

    const text = cardText(editMessage);
    expect(text).toMatch(/1 of 2 ballots/);
    expect(text).not.toContain("8.00");
    expect(text).not.toMatch(/Advances/);
  });

  it("puts the scores on once the round has settled", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: zeroPassed(),
              1: {
                assignedPiece: "https://piece",
                windowOpenedAt: "2026-11-18T00:00:00.000Z",
                submittedAt: "2026-11-19T00:00:00.000Z",
                submissionUrl: "https://after",
                reviewMessageId: "msg1",
                reviewChannelId: "chan1",
                ballots: { d1: { targetScore: 8, at: "2026-11-19T00:00:00.000Z" } },
              },
            },
            ...sealed,
            document: feedbackSent(),
          }),
        ),
      ]),
    );
    await scoreRound(env, "100", "d2", { targetScore: 8 }, POLICY, OPEN);

    const text = cardText(editMessage);
    expect(text).toMatch(/4\.00 → 8\.00/);
    expect(text).toMatch(/Advances/);
    expect(text).toMatch(/settled, not sent/);
  });

  /**
   * Round 1's card is unreadable without these two: a video of someone dancing
   * says nothing until you know which one thing you are watching, and what it
   * looked like before.
   */
  it("carries Round 1's target and its fixed before-number", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: zeroPassed(),
              1: {
                assignedPiece: "https://piece",
                windowOpenedAt: "2026-11-18T00:00:00.000Z",
              },
            },
            ...sealed,
            document: feedbackSent(),
          }),
        ),
      ]),
    );
    await submit(env, "100", 1, "https://after", TIMELINE, POLICY, OPEN);
    const text = cardText(postToChannelByName);
    expect(text).toContain("elbows collapse on extensions");
    expect(text).toContain("4.00/10");
  });

  it("replaces the video on the card it already has, rather than posting twice", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: {
                submittedAt: "2026-11-16T00:00:00.000Z",
                submissionUrl: "https://first",
                reviewMessageId: "msg1",
                reviewChannelId: "chan1",
              },
            },
          }),
        ),
      ]),
    );
    await submit(env, "100", 0, "https://second", TIMELINE, POLICY, OPEN);

    expect(postToChannelByName).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(cardText(editMessage)).toContain("https://second");
  });

  /**
   * The submission is written before the card is posted, so a Discord failure
   * degrades to how the process worked before the card existed.
   */
  it("keeps the submission when the card can't be posted, and says so", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    postToChannelByName.mockRejectedValueOnce(new Error("no such channel"));

    const result = await submit(env, "100", 0, "https://cover", TIMELINE, POLICY, OPEN);
    expect(result.ok).toBe(true);
    expect(roundOf((await getRecord(env, "100"))!, 0).submissionUrl).toBe("https://cover");
    expect(alertDirectors).toHaveBeenCalledTimes(1);
    expect(String(alertDirectors.mock.calls[0]?.[1])).toMatch(/submission is\s+recorded/);
  });

  /** A stale card is bad; a scoring command that reports failure is worse. */
  it("doesn't fail a ballot because the card couldn't be edited", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: {
                submittedAt: "2026-11-16T00:00:00.000Z",
                reviewMessageId: "msg1",
                reviewChannelId: "chan1",
              },
            },
          }),
        ),
      ]),
    );
    editMessage.mockRejectedValueOnce(new Error("message gone"));

    const result = await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, OPEN);
    expect(result.ok).toBe(true);
    expect(roundOf((await getRecord(env, "100"))!, 0).ballots?.d1?.verdict).toBe("pass");
  });

  it("marks the card sent once the result has gone out", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: zeroPassed(),
              1: {
                assignedPiece: "https://piece",
                windowOpenedAt: "2026-11-18T00:00:00.000Z",
                submittedAt: "2026-11-19T00:00:00.000Z",
                submissionUrl: "https://after",
                reviewMessageId: "msg1",
                reviewChannelId: "chan1",
                ballots: {
                  d1: { targetScore: 8, at: "2026-11-19T00:00:00.000Z" },
                  d2: { targetScore: 8, at: "2026-11-19T00:00:00.000Z" },
                },
              },
            },
            ...sealed,
            document: feedbackSent(),
          }),
        ),
      ]),
    );
    const result = await sendResult(env, "100", DIRECTORS, CTX, POLICY, OPEN);
    expect(result.ok).toBe(true);

    const text = cardText(editMessage);
    expect(text).toMatch(/Result sent/);
    expect(text).toMatch(/result sent/);
    expect(text).toMatch(/nothing owed/);
  });
});

/**
 * The card's buttons are the point of putting it in that channel at all:
 * `/diamonds` is registered to the dance guild and the card hangs in the
 * community one, so a command named on it is a command you have to go
 * elsewhere to run.
 */
describe("the review card's buttons", () => {
  it("gives Round 0 a pass, a fail and the document", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer())]));
    await submit(env, "100", 0, "https://cover", TIMELINE, POLICY, OPEN);

    expect(cardButtons(postToChannelByName)).toEqual([
      "dia|verdict|100:pass",
      "dia|verdict|100:fail",
      "dia|doc|100",
    ]);
  });

  /**
   * No round in any of them. A button lives as long as its message, so the
   * round is derived from the record when it's pressed — a card from last week
   * with `:1` baked in would take a Round 1 ballot on a Round 2 video.
   */
  it("names the dancer and never the round", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: zeroPassed(),
              1: { assignedPiece: "https://piece", windowOpenedAt: "2026-11-18T00:00:00.000Z" },
            },
            ...sealed,
            document: feedbackSent(),
          }),
        ),
      ]),
    );
    await submit(env, "100", 1, "https://after", TIMELINE, POLICY, OPEN);

    const ids = cardButtons(postToChannelByName);
    expect(ids).toEqual(["dia|score|100", "dia|note|100"]);
    expect(ids.every((one) => !/\|\d$/.test(one))).toBe(true);
  });

  /** The send button is a read-back, never a send — it is the irreversible step. */
  it("offers the read-back only once the round has settled", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: zeroPassed(),
              1: {
                assignedPiece: "https://piece",
                windowOpenedAt: "2026-11-18T00:00:00.000Z",
                submittedAt: "2026-11-19T00:00:00.000Z",
                submissionUrl: "https://after",
                reviewMessageId: "msg1",
                reviewChannelId: "chan1",
                ballots: { d1: { targetScore: 8, at: "2026-11-19T00:00:00.000Z" } },
              },
            },
            ...sealed,
            document: feedbackSent(),
          }),
        ),
      ]),
    );
    await scoreRound(env, "100", "d2", { targetScore: 8 }, POLICY, OPEN);
    expect(cardButtons(editMessage)).toContain("dia|preview|100");
  });

  it("takes every button off once the result has gone", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: zeroPassed(),
              1: {
                assignedPiece: "https://piece",
                windowOpenedAt: "2026-11-18T00:00:00.000Z",
                submittedAt: "2026-11-19T00:00:00.000Z",
                submissionUrl: "https://after",
                reviewMessageId: "msg1",
                reviewChannelId: "chan1",
                ballots: {
                  d1: { targetScore: 8, at: "2026-11-19T00:00:00.000Z" },
                  d2: { targetScore: 8, at: "2026-11-19T00:00:00.000Z" },
                },
              },
            },
            ...sealed,
            document: feedbackSent(),
          }),
        ),
      ]),
    );
    await sendResult(env, "100", DIRECTORS, CTX, POLICY, OPEN);
    expect(cardButtons(editMessage)).toEqual([]);
  });

  it("offers to rewrite a document that exists", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: {
              0: {
                submittedAt: "2026-11-16T00:00:00.000Z",
                reviewMessageId: "msg1",
                reviewChannelId: "chan1",
              },
            },
          }),
        ),
      ]),
    );
    await fileFeedback(
      env,
      "100",
      {
        content: "Clean lines.",
        strengths: ["a", "b", "c"],
        growthAreas: ["arms"],
      },
      "d1",
      TIMELINE,
      POLICY,
      OPEN,
    );
    expect(cardText(editMessage)).toMatch(/Feedback written/);
    expect(cardButtons(editMessage)).toContain("dia|doc|100");
  });

  /** Every new action has to survive the round trip through a custom id. */
  it("parses each of its own ids back", () => {
    for (const id of [
      "dia|verdict|100:pass",
      "dia|score|100",
      "dia|score-save|100",
      "dia|doc|100",
      "dia|note|100",
      "dia|preview|100",
    ]) {
      expect(parseDiamondsCustomId(id)).not.toBeNull();
    }
    expect(parseDiamondsCustomId("dia|verdict|")).toBeNull();
  });
});

/**
 * Membership, which is the only thing on the record that outlives the audition.
 */
describe("membership", () => {
  const eights = {
    technicality: 8,
    execution: 8,
    performance: 8,
    musicality: 8,
  } as const;

  /** Everything done but the Round 2 result. */
  const finalist = (over: Partial<DiamondsRecord> = {}): DiamondsRecord =>
    dancer({
      rounds: {
        0: zeroPassed(),
        1: {
          submittedAt: "2026-11-19T00:00:00.000Z",
          resultSentAt: "2026-11-20T00:00:00.000Z",
          outcome: "advanced",
        },
        2: {
          assignedPiece: "https://final",
          windowOpenedAt: "2026-11-21T00:00:00.000Z",
          submittedAt: "2026-11-22T00:00:00.000Z",
          submissionUrl: "https://mine",
          ballots: {
            d1: { scores: { ...eights }, at: "2026-11-23T00:00:00.000Z" },
            d2: { scores: { ...eights }, at: "2026-11-23T00:00:00.000Z" },
          },
        },
      },
      ...sealed,
      document: feedbackSent(),
      ...over,
    });

  it("starts membership when the pass is sent, and sets the date from it", async () => {
    const { env } = envWith(Object.fromEntries([seed(finalist())]));
    const sent = new Date("2026-11-24T12:00:00Z");

    const result = await sendResult(env, "100", DIRECTORS, CTX, POLICY, sent);
    expect(result.ok && result.outcome).toBe("passed");

    const stored = (await getRecord(env, "100"))!;
    expect(stored.memberSince).toBe(sent.toISOString());
    // November, so the January two years out.
    expect(stored.enforcedAt).toBe("2028-01-01T05:00:00.000Z");
  });

  /**
   * Said once, at the one moment it is unambiguously good news. First hearing
   * of it sixty days before it expires would make it an eviction notice.
   */
  it("tells them the date inside the message that welcomes them", async () => {
    const { env } = envWith(Object.fromEntries([seed(finalist())]));
    await sendResult(env, "100", DIRECTORS, CTX, POLICY, new Date("2026-11-24T12:00:00Z"));

    const sent = String(sendDirectMessage.mock.calls.at(-1)?.[2]?.content);
    expect(sent).toMatch(/You've passed/);
    expect(sent).toMatch(/membership runs to/);
  });

  /**
   * Keyed by rung, so a renewed member carrying last term's markers would have
   * every rung of the new term already marked sent — and would never be warned
   * again. The bug can't fire until re-auditions exist; the guard goes in with
   * the thing it guards.
   */
  it("starts the ladder over when the date moves", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          finalist({
            renewalNoticedAt: {
              "60": "2026-01-01T00:00:00.000Z",
              "30": "2026-02-01T00:00:00.000Z",
              "20": "2026-02-10T00:00:00.000Z",
            },
          }),
        ),
      ]),
    );
    await sendResult(env, "100", DIRECTORS, CTX, POLICY, new Date("2026-11-24T12:00:00Z"));
    expect((await getRecord(env, "100"))?.renewalNoticedAt).toBeUndefined();
  });

  it("gives a Diamond Director no date to be chased about", async () => {
    const { env } = envWith({
      "config:role.diamonds_director": "role-judge",
      ...Object.fromEntries([seed(finalist({ discordId: "d1" }))]),
    });
    memberRoles.mockResolvedValue(["role-judge"]);
    await sendResult(env, "d1", DIRECTORS, CTX, POLICY, new Date("2026-11-24T12:00:00Z"));

    const stored = (await getRecord(env, "d1"))!;
    expect(roundOf(stored, 2).outcome).toBe("passed");
    expect(stored.enforcedAt).toBeUndefined();
  });

  /**
   * The role is the only effect of passing that happens outside the bot, and it
   * had been missing: the record said Diamond and Discord didn't.
   */
  it("adds the Diamonds role when someone passes", async () => {
    const { env } = envWith({
      "config:role.diamonds": "role-diamonds",
      ...Object.fromEntries([seed(finalist())]),
    });
    await sendResult(env, "100", DIRECTORS, CTX, POLICY, new Date("2026-11-24T12:00:00Z"));
    expect(addRole).toHaveBeenCalledWith(env, "g-dance", "100", "role-diamonds");
  });

  /** And a result that's been decided still reaches them if the role doesn't. */
  it("sends the result even when the role can't be added", async () => {
    const { env } = envWith(Object.fromEntries([seed(finalist())]));
    const sent = await sendResult(env, "100", DIRECTORS, CTX, POLICY, new Date("2026-11-24T12:00:00Z"));
    expect(sent.ok).toBe(true);
    expect(addRole).not.toHaveBeenCalled();
    expect((await getRecord(env, "100"))!.enforcedAt).toBeTruthy();
  });

  it("gives nothing to someone who didn't pass", async () => {
    const low = { technicality: 5, execution: 5, performance: 5, musicality: 5 } as const;
    const { env } = envWith(
      Object.fromEntries([
        seed(
          finalist({
            rounds: {
              ...finalist().rounds,
              2: {
                ...finalist().rounds[2]!,
                ballots: {
                  d1: { scores: { ...low }, at: "2026-11-23T00:00:00.000Z" },
                  d2: { scores: { ...low }, at: "2026-11-23T00:00:00.000Z" },
                },
              },
            },
          }),
        ),
      ]),
    );
    await sendResult(env, "100", DIRECTORS, CTX, POLICY, new Date("2026-11-24T12:00:00Z"));

    const stored = (await getRecord(env, "100"))!;
    expect(stored.memberSince).toBeUndefined();
    expect(stored.enforcedAt).toBeUndefined();
  });
});

/**
 * Registering again is the door. One door rather than a second command: a
 * dancer who has finished and wants another go looks for the thing they used
 * the first time.
 */
describe("registering again", () => {
  const finished = (): DiamondsRecord =>
    dancer({
      registeredAt: "2026-10-01T00:00:00.000Z",
      rounds: {
        0: zeroPassed(),
        1: { submittedAt: "a", resultSentAt: "b", outcome: "advanced" },
        2: { submittedAt: "c", resultSentAt: "d", outcome: "passed" },
      },
      ...sealed,
      document: feedbackSent(),
      memberSince: "2026-11-24T00:00:00.000Z",
      enforcedAt: "2028-01-01T05:00:00.000Z",
    });

  it("archives the finished audition and starts a clean one", async () => {
    const { env } = envWith(Object.fromEntries([seed(finished())]));
    const again = new Date("2027-06-01T12:00:00Z");

    const result = await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, again);
    expect(result.ok).toBe(true);

    const stored = (await getRecord(env, "100"))!;
    expect(stored.rounds).toEqual({});
    expect(stored.history).toHaveLength(1);
    expect(stored.cohort).toBe("returning");
    expect(stored.enforcedAt).toBe("2028-01-01T05:00:00.000Z");
    expect(stored.targetFixedAt).toBeUndefined();
  });

  /**
   * Someone who withdrew part-way and came back is picking up where they left
   * off, not starting again — which is what this always did.
   */
  /**
   * A director overriding a withdrawal is almost always fixing a mistake, so
   * that door restores the audition. The dancer's own door starts a new one.
   */
  it("lets a director restore an audition that was dropped", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: { 0: zeroPassed(), 1: { assignedPiece: "https://piece" } },
            ...sealed,
            document: feedbackSent(),
            withdrawnAt: "2026-12-01T00:00:00.000Z",
          }),
        ),
      ]),
    );
    await addEntry(env, "100", "new", 1, TIMELINE, POLICY, OPEN);

    const stored = (await getRecord(env, "100"))!;
    expect(stored.history).toBeUndefined();
    expect(roundOf(stored, 1).assignedPiece).toBe("https://piece");
    expect(stored.withdrawnAt).toBeUndefined();
  });

  /** The reset runs, and then the cohort the director chose wins. */
  it("lets a director add a finished member back with a cohort of their choosing", async () => {
    const { env } = envWith(Object.fromEntries([seed(finished())]));
    const result = await addEntry(env, "100", "new", 0, TIMELINE, POLICY, new Date("2027-06-01T12:00:00Z"));
    expect(result.ok).toBe(true);

    const stored = (await getRecord(env, "100"))!;
    expect(stored.history).toHaveLength(1);
    expect(stored.rounds).toEqual({});
    expect(stored.cohort).toBe("new");
  });

  /** Round 0 for a renewing member is the application and current feedback. */
  it("asks a renewing member for nothing and opens their feedback", async () => {
    const { env } = envWith(Object.fromEntries([seed(finished())]));
    await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, new Date("2027-06-01T12:00:00Z"));
    const stored = (await getRecord(env, "100"))!;

    expect((await submit(env, "100", 0, "https://nope", TIMELINE, POLICY, new Date("2027-06-02T12:00:00Z"))).ok).toBe(false);
    expect(statusPanel(stored, 0, CTX, new Date("2027-06-02T12:00:00Z")).content).toMatch(
      /renewal is in/,
    );
    expect(statusPanel(stored, 0, CTX, new Date("2027-06-02T12:00:00Z")).content).toMatch(
      /audition 2/,
    );
  });
});

describe("the renewal notices", () => {
  const member = (over: Partial<DiamondsRecord> = {}): DiamondsRecord =>
    dancer({
      rounds: { 0: zeroPassed(), 2: { resultSentAt: "2027-11-15T00:00:00.000Z", outcome: "passed" } },
      document: feedbackSent(),
      memberSince: "2027-11-15T00:00:00.000Z",
      enforcedAt: "2029-01-01T05:00:00.000Z",
      ...over,
    });

  it("says nothing while the date is months off", async () => {
    const { env } = envWith(Object.fromEntries([seed(member())]));
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-09-01T12:00:00Z"));
    expect(run).toEqual(quiet);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  it("sends the two-month notice, once", async () => {
    const { env } = envWith(Object.fromEntries([seed(member())]));
    const day = new Date("2028-11-05T12:00:00Z");

    expect(await runDiamondsSweep(env, TIMELINE, POLICY, day)).toEqual({
      ...quiet,
      renewals: 1,
    });
    expect(String(sendDirectMessage.mock.calls[0]?.[2]?.content)).toMatch(
      /membership runs to/,
    );
    expect((await getRecord(env, "100"))?.renewalNoticedAt?.["60"]).toBeTruthy();

    sendDirectMessage.mockClear();
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, day)).toEqual(quiet);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  /**
   * A sweep that was down for a fortnight sends the urgent rung and marks the
   * gentle ones off, rather than working through the ladder a day at a time.
   */
  it("sends only the most urgent rung, and retires the rest", async () => {
    const { env } = envWith(Object.fromEntries([seed(member())]));
    await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));

    const sent = String(sendDirectMessage.mock.calls[0]?.[2]?.content);
    expect(sent).toMatch(/12 days/);
    expect(sent).toMatch(/come off the Diamonds role/);

    const marked = (await getRecord(env, "100"))?.renewalNoticedAt ?? {};
    expect(Object.keys(marked).sort()).toEqual(["20", "30", "60"]);
  });

  /** The gentle one never says it. Three removal warnings is none. */
  it("doesn't threaten removal two months out", async () => {
    const { env } = envWith(Object.fromEntries([seed(member())]));
    await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-11-05T12:00:00Z"));
    expect(String(sendDirectMessage.mock.calls[0]?.[2]?.content)).not.toMatch(/come off/);
  });

  /** Past the date there is nothing left to warn about — it's revoked instead. */
  it("stops warning once the date has gone by", async () => {
    const { env } = envWith(Object.fromEntries([seed(member())]));
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-15T12:00:00Z"));
    expect(run.renewals).toBe(0);
  });

  /** They're doing the thing the notice would be asking for. */
  it("goes quiet while they're mid-re-audition", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(member({
          registeredAt: "2028-11-20T00:00:00.000Z",
          rounds: { 0: { submittedAt: "2028-12-01T00:00:00.000Z", submissionUrl: "https://again" } },
        })),
      ]),
    );
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));
    expect(run.renewals).toBe(0);
  });

  /**
   * The two directors are Diamonds too, and their renewal is a formality —
   * they're the ones judging it. Chasing them for a verdict they would have to
   * give themselves is the bot chasing its own judges.
   */
  it("doesn't chase a Diamond Director about their own renewal", async () => {
    const { env } = envWith({
      "config:role.diamonds_director": "role-judge",
      ...Object.fromEntries([seed(member({ discordId: "d1" }))]),
    });
    memberRoles.mockResolvedValue(["role-judge"]);
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));
    expect(run.renewals).toBe(0);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  /**
   * And it is the *role* that exempts, not being a director. The director list
   * runs rank 7's cycles and rank 12's auditions too, so someone on it who
   * doesn't judge Diamonds owes their renewal like anyone else.
   */
  it("still chases a director who doesn't judge Diamonds", async () => {
    const { env } = envWith({
      "config:role.diamonds_director": "role-judge",
      ...Object.fromEntries([seed(member({ discordId: "d1" }))]),
    });
    memberRoles.mockResolvedValue(["some-other-role"]);
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));
    expect(run.renewals).toBe(1);
  });

  /** No role configured means nobody is exempt, which is the safe direction. */
  it("chases everybody when the judge role isn't set", async () => {
    const { env } = envWith(Object.fromEntries([seed(member({ discordId: "d1" }))]));
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));
    expect(run.renewals).toBe(1);
  });

  /** Forgetting the list chases everybody rather than nobody. */
  it("chases everyone when no director list is given", async () => {
    const { env } = envWith(Object.fromEntries([seed(member({ discordId: "d1" }))]));
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));
    expect(run.renewals).toBe(1);
  });

  /**
   * Withdrawing takes you off the audition, not out of Diamonds. The round
   * reminders stop; the one about your membership doesn't.
   */
  it("still warns a member who dropped their re-audition", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(member({ withdrawnAt: "2028-06-01T00:00:00.000Z" }))]),
    );
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));
    expect(run).toEqual({ ...quiet, renewals: 1 });
  });

  it("stops the round reminders for someone who withdrew", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            withdrawnAt: "2028-06-01T00:00:00.000Z",
            rounds: {
              0: zeroPassed(),
              1: {
                assignedPiece: "https://piece",
                // A window closing tomorrow, which would otherwise be reminded.
                windowOpenedAt: "2028-12-18T12:00:00.000Z",
              },
            },
            ...sealed,
            document: feedbackSent(),
          }),
        ),
      ]),
    );
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));
    expect(run).toEqual(quiet);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  /** Dropping it costs them nothing that membership depends on. */
  it("keeps the membership through a withdrawal", async () => {
    const { env } = envWith(Object.fromEntries([seed(member())]));
    await withdraw(env, "100");
    const stored = (await getRecord(env, "100"))!;
    expect(stored.memberSince).toBe("2027-11-15T00:00:00.000Z");
    expect(stored.enforcedAt).toBe("2029-01-01T05:00:00.000Z");
  });
});

/**
 * The only thing in this system that changes something outside the bot, and the
 * reason it runs daily rather than twice a year: with nine to fifteen months and
 * three warnings, reaching the date at all is rare, so this is a trickle of at
 * most a person or two rather than a mass event needing a dry run.
 */
describe("membership running out", () => {
  const ROLE = { "config:role.diamonds": "role-diamonds" };

  const member = (over: Partial<DiamondsRecord> = {}): DiamondsRecord =>
    dancer({
      rounds: { 0: zeroPassed(), 2: { resultSentAt: "2027-11-15T00:00:00.000Z", outcome: "passed" } },
      document: feedbackSent(),
      memberSince: "2027-11-15T00:00:00.000Z",
      enforcedAt: "2029-01-01T05:00:00.000Z",
      renewalNoticedAt: { "60": "x", "30": "y", "20": "z" },
      ...over,
    });

  const AFTER = new Date("2029-01-01T12:00:00Z");

  it("takes the role off, records it, and tells them", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(member())]) });
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);

    expect(run.lapsed).toBe(1);
    expect(removeRole).toHaveBeenCalledWith(
      expect.anything(),
      "g-dance",
      "100",
      "role-diamonds",
    );
    expect(String(sendDirectMessage.mock.calls[0]?.[2]?.content)).toMatch(
      /membership has ended/,
    );
  });

  it("clears the membership and keeps the fact", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(member())]) });
    await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);

    const stored = (await getRecord(env, "100"))!;
    expect(stored.lapsedAt).toBe(AFTER.toISOString());
    expect(stored.memberSince).toBeUndefined();
    expect(stored.enforcedAt).toBeUndefined();
    expect(stored.renewalNoticedAt).toBeUndefined();
  });

  /** Never silent: a role coming off somebody is something the directors hear. */
  it("tells the directors every time", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(member())]) });
    await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);
    expect(String(alertDirectors.mock.calls[0]?.[1])).toMatch(/has come off Diamonds/);
  });

  it("does it once", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(member())]) });
    await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);
    removeRole.mockClear();

    const again = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-02T12:00:00Z"));
    expect(again.lapsed).toBe(0);
    expect(removeRole).not.toHaveBeenCalled();
  });

  it("leaves a membership that hasn't run out alone", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(member())]) });
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-31T12:00:00Z"));
    expect(run.lapsed).toBe(0);
    expect(removeRole).not.toHaveBeenCalled();
  });

  /** This is the case the directors asked for in so many words. */
  it("revokes a member who dropped a re-audition and never picked it up", async () => {
    const { env } = envWith({
      ...ROLE,
      ...Object.fromEntries([seed(member({ withdrawnAt: "2028-12-05T00:00:00.000Z" }))]),
    });
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);
    expect(run.lapsed).toBe(1);
    expect((await getRecord(env, "100"))?.lapsedAt).toBeTruthy();
  });

  it("never revokes a Diamond Director", async () => {
    const { env } = envWith({
      ...ROLE,
      "config:role.diamonds_director": "role-judge",
      ...Object.fromEntries([seed(member({ discordId: "d1" }))]),
    });
    memberRoles.mockResolvedValue(["role-judge"]);
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);
    expect(run.lapsed).toBe(0);
    expect(removeRole).not.toHaveBeenCalled();
  });

  /**
   * Fails closed, both ways. A record marked revoked while the role stayed on
   * is the one failure here that nobody would ever notice.
   */
  it("records nothing when no role is configured", async () => {
    const { env } = envWith(Object.fromEntries([seed(member())]));
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);

    expect(run).toEqual({ ...quiet, blocked: 1 });
    expect((await getRecord(env, "100"))?.lapsedAt).toBeUndefined();
    expect((await getRecord(env, "100"))?.enforcedAt).toBe("2029-01-01T05:00:00.000Z");
  });

  it("records nothing when Discord refuses the removal", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(member())]) });
    removeRole.mockRejectedValueOnce(new Error("missing permissions"));

    const run = await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);
    expect(run).toEqual({ ...quiet, blocked: 1 });
    expect((await getRecord(env, "100"))?.lapsedAt).toBeUndefined();
  });

  /**
   * The DM comes after the role and cannot stop it — a membership that could
   * only end if the person were reachable would make closed DMs a way to stay a
   * Diamond for ever.
   */
  it("still revokes someone it can't reach, and says so", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(member())]) });
    sendDirectMessage.mockResolvedValueOnce(false);

    const run = await runDiamondsSweep(env, TIMELINE, POLICY, AFTER);
    expect(run.lapsed).toBe(1);
    expect((await getRecord(env, "100"))?.lapsedAt).toBeTruthy();
    expect(String(alertDirectors.mock.calls[0]?.[1])).toMatch(/Couldn't DM/);
  });
});

/**
 * The wait after an audition that didn't pass, at the door it is enforced at.
 */
describe("registering inside the wait", () => {
  const failed = (over: Partial<DiamondsRecord> = {}): DiamondsRecord =>
    dancer({
      rounds: {
        0: zeroPassed(),
        1: { submittedAt: "a", resultSentAt: "2026-11-20T00:00:00.000Z", outcome: "failed" },
      },
      ...sealed,
      document: feedbackSent(),
      ...over,
    });

  it("refuses, and says when they can", async () => {
    const { env } = envWith(Object.fromEntries([seed(failed())]));
    const result = await register(
      env, "100", "Ada", "new", COVER, TIMELINE, POLICY,
      new Date("2027-01-10T12:00:00Z"),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/6-month wait/);
    expect(result.ok === false && result.reason).toMatch(/ask a director/i);
  });

  it("lets them in once it's run out", async () => {
    const { env } = envWith(Object.fromEntries([seed(failed())]));
    const result = await register(
      env, "100", "Ada", "new", COVER, TIMELINE, POLICY,
      new Date("2027-05-21T12:00:00Z"),
    );
    expect(result.ok).toBe(true);
    expect((await getRecord(env, "100"))?.history).toHaveLength(1);
  });

  /** Checked before the archive, which is what would hide the audition it counts from. */
  it("doesn't archive the audition it's counted from", async () => {
    const { env } = envWith(Object.fromEntries([seed(failed())]));
    await register(
      env, "100", "Ada", "new", COVER, TIMELINE, POLICY,
      new Date("2027-01-10T12:00:00Z"),
    );
    const stored = (await getRecord(env, "100"))!;
    expect(stored.history).toBeUndefined();
    expect(roundOf(stored, 1).outcome).toBe("failed");
  });

  /** The refusal routes a judgement to the two people entitled to make it. */
  it("lets a director put them on the list anyway", async () => {
    const { env } = envWith(Object.fromEntries([seed(failed())]));
    const result = await addEntry(
      env, "100", "new", 0, TIMELINE, POLICY, new Date("2027-01-10T12:00:00Z"),
    );
    expect(result.ok).toBe(true);
    const stored = (await getRecord(env, "100"))!;
    expect(stored.history).toHaveLength(1);
    expect(stored.rounds).toEqual({});
  });

  /**
   * The exploit this closes: withdraw before the result, keep the record clean,
   * register again next week.
   */
  it("holds someone who dropped out to the same wait", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            rounds: { 0: zeroPassed(), 1: { assignedPiece: "https://piece" } },
            ...sealed,
            document: feedbackSent(),
            withdrawnAt: "2026-12-01T00:00:00.000Z",
          }),
        ),
      ]),
    );
    const soon = await register(
      env, "100", "Ada", "new", COVER, TIMELINE, POLICY,
      new Date("2026-12-02T12:00:00Z"),
    );
    expect(soon.ok).toBe(false);

    const later = await register(
      env, "100", "Ada", "new", COVER, TIMELINE, POLICY,
      new Date("2027-06-02T12:00:00Z"),
    );
    expect(later.ok).toBe(true);
    // And it starts a new audition rather than resuming the dropped one: the
    // only thing in `rounds` is the cover they just sent with the registration.
    expect(Object.keys((await getRecord(env, "100"))!.rounds)).toEqual(["0"]);
    expect(roundOf((await getRecord(env, "100"))!, 0).submissionUrl).toBe(COVER);
    expect((await getRecord(env, "100"))?.history).toHaveLength(1);
    expect((await getRecord(env, "100"))?.cohort).toBe("new");
  });

  it("tells them the date on their status without making them try", async () => {
    const stored = failed();
    expect(statusPanel(stored, 1, CTX, new Date("2027-01-10T12:00:00Z")).content).toMatch(
      /register again from/,
    );
  });
});

/**
 * Grandfathering. The roster predates the bot: there are Diamonds whose
 * audition happened in a room, and until somebody writes their date down they
 * are invisible to all of this.
 */
describe("granting a membership", () => {
  const NOW = new Date("2026-11-20T12:00:00Z");

  it("records a date with no audition behind it", async () => {
    const { env } = envWith();
    const result = await grantMembership(env, "200", "Jo", "2028-07-01T23:59:00.000Z", NOW);
    expect(result.ok).toBe(true);

    const stored = (await getRecord(env, "200"))!;
    expect(stored.enforcedAt).toBe("2028-07-01T23:59:00.000Z");
    expect(stored.memberSince).toBe(NOW.toISOString());
    expect(stored.rounds).toEqual({});
    expect(stored.cohort).toBe("returning");
  });

  it("derives the date from today when none is given", async () => {
    const { env } = envWith();
    await grantMembership(env, "200", "Jo", undefined, NOW);
    // November, so the January two years out.
    expect((await getRecord(env, "200"))?.enforcedAt).toBe("2028-01-01T05:00:00.000Z");
  });

  it("tells them, since a date nobody knows about is no use", async () => {
    const { env } = envWith();
    await grantMembership(env, "200", "Jo", undefined, NOW);
    expect(String(sendDirectMessage.mock.calls[0]?.[2]?.content)).toMatch(/on the books until/);
  });

  it("starts them on the notice ladder", async () => {
    const { env } = envWith();
    await grantMembership(env, "200", "Jo", "2026-12-20T23:59:00.000Z", NOW);
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-12-05T12:00:00Z"));
    expect(run.renewals).toBe(1);
  });

  /**
   * The two mistakes aren't symmetrical: refusing to shorten a membership costs
   * a conversation, and silently shortening one costs somebody their place.
   */
  it("won't guess a new date over one somebody earned", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ memberSince: "2026-01-01T00:00:00.000Z", enforcedAt: "2027-07-01T04:00:00.000Z" })),
      ]),
    );
    const result = await grantMembership(env, "100", "Ada", undefined, NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/already a member/);
    expect((await getRecord(env, "100"))?.enforcedAt).toBe("2027-07-01T04:00:00.000Z");
  });

  it("will move it when the date is given explicitly", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ memberSince: "2026-01-01T00:00:00.000Z", enforcedAt: "2027-07-01T04:00:00.000Z" })),
      ]),
    );
    const result = await grantMembership(env, "100", "Ada", "2029-01-01T23:59:00.000Z", NOW);
    expect(result.ok).toBe(true);
    expect((await getRecord(env, "100"))?.enforcedAt).toBe("2029-01-01T23:59:00.000Z");
  });

  it("refuses a date that has already gone", async () => {
    const { env } = envWith();
    const result = await grantMembership(env, "200", "Jo", "2026-01-01T23:59:00.000Z", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/already passed/);
  });

  /** Granting after a lapse is how somebody is put back. */
  it("clears a lapse and the old ladder", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            lapsedAt: "2026-01-01T00:00:00.000Z",
            renewalNoticedAt: { "20": "x" },
          }),
        ),
      ]),
    );
    await grantMembership(env, "100", "Ada", "2028-07-01T23:59:00.000Z", NOW);
    const stored = (await getRecord(env, "100"))!;
    expect(stored.lapsedAt).toBeUndefined();
    expect(stored.renewalNoticedAt).toBeUndefined();
  });
});

/**
 * The decision the directors made out loud: a member who fails a renewal is out
 * at their date, and can try again six months after the failure.
 *
 * Written as one sequence rather than four unit tests because it is not one
 * rule — it's the enforcement date, the retry wait, the lapse and the cohort
 * reset interacting, and each of them was decided separately. This is the test
 * that fails if any one of them moves.
 */
describe("a failed renewal, start to finish", () => {
  const ROLE = { "config:role.diamonds": "role-diamonds" };

  /** A Diamond since Nov 2027 whose renewal didn't advance at Round 1. */
  const seeded = () =>
    dancer({
      cohort: "returning",
      registeredAt: "2028-09-01T00:00:00.000Z",
      rounds: {
        0: {
          resultSentAt: "2028-09-10T00:00:00.000Z",
          outcome: "passed",
          ballots: {
            d1: { verdict: "pass" as const, at: "2028-09-09T00:00:00.000Z" },
            d2: { verdict: "pass" as const, at: "2028-09-09T00:00:00.000Z" },
          },
        },
        1: {
          submittedAt: "2028-10-15T00:00:00.000Z",
          resultSentAt: "2028-10-20T00:00:00.000Z",
          outcome: "failed",
        },
      },
      document: feedbackSent("2028-09-10T00:00:00.000Z"),
      ...sealed,
      memberSince: "2027-11-15T00:00:00.000Z",
      enforcedAt: "2029-01-01T05:00:00.000Z",
      history: [{ rounds: {}, outcome: "passed" as const, finishedAt: "2027-11-15T00:00:00.000Z" }],
    });

  it("warns them that the wait outruns their date, and points at a director", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(seeded())]) });
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-20T12:00:00Z"));

    expect(run.renewals).toBe(1);
    const sent = String(sendDirectMessage.mock.calls[0]?.[2]?.content);
    expect(sent).toMatch(/can't re-audition before/);
    expect(sent).toMatch(/Talk to a director/);
    // Never tells them to do the thing they are barred from doing.
    expect(sent).not.toMatch(/re-audition before then and it renews/);
  });

  it("takes the role off on their date", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(seeded())]) });
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-01T12:00:00Z"));

    expect(run.lapsed).toBe(1);
    expect(removeRole).toHaveBeenCalledWith(expect.anything(), "g-dance", "100", "role-diamonds");
    expect((await getRecord(env, "100"))?.enforcedAt).toBeUndefined();
  });

  it("won't let them back before six months from the failure", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(seeded())]) });
    await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-01T12:00:00Z"));

    const early = await register(
      env, "100", "Ada", "new", COVER, TIMELINE, POLICY,
      new Date("2029-02-01T12:00:00Z"),
    );
    expect(early.ok).toBe(false);
    expect(early.ok === false && early.reason).toMatch(/6-month wait/);
  });

  /** Six months from the result, which was 20 October. */
  it("lets them back after it, owing a cover", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(seeded())]) });
    await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-01T12:00:00Z"));

    const back = await register(
      env, "100", "Ada", "new", COVER, TIMELINE, POLICY,
      new Date("2029-04-21T12:00:00Z"),
    );
    expect(back.ok).toBe(true);

    const stored = (await getRecord(env, "100"))!;
    expect(stored.history).toHaveLength(2);
    // Failed, so a newcomer again — which is why that registration needed a
    // cover, and why the new audition already has one in.
    expect(stored.cohort).toBe("new");
    expect(Object.keys(stored.rounds)).toEqual(["0"]);
    expect(stored.memberSince).toBeUndefined();
  });

  /**
   * The wait is six months from the failure, not "never again before your
   * date" — so a renewal that fails early enough leaves room to try again
   * before the date, and that is deliberate.
   */
  it("leaves room for another go when the failure lands early", async () => {
    const early = dancer({
      ...seeded(),
      rounds: {
        ...seeded().rounds,
        1: {
          submittedAt: "2028-02-10T00:00:00.000Z",
          resultSentAt: "2028-02-15T00:00:00.000Z",
          outcome: "failed",
        },
      },
    });
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(early)]) });

    const back = await register(
      env, "100", "Ada", "new", COVER, TIMELINE, POLICY,
      new Date("2028-08-16T12:00:00Z"),
    );
    expect(back.ok).toBe(true);
    // Still a member, with the same date — they have until January to pass.
    expect((await getRecord(env, "100"))?.enforcedAt).toBe("2029-01-01T05:00:00.000Z");
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
   * Round 0 has no window of its own, so the only clock on it is the two months
   * for the whole run — their own date, counted from their own registration,
   * which is the only kind of deadline left.
   */
  it("names their own deadline, not a shared one", () => {
    const panel = roundPanel(
      dancer({ registeredAt: "2026-11-16T00:00:00.000Z" }),
      0,
      CTX,
      OPEN,
    );
    expect(panel.content).toMatch(/All three rounds by/);
    // Registered NOV 16, panel read NOV 18: 58 of the 60 days left.
    expect(panel.content).toMatch(/\*\*58\*\* left/);
  });

  /** And says nothing about a clock to somebody who was never given one. */
  it("says nothing to a record from before the deadline existed", () => {
    expect(roundPanel(dancer(), 0, CTX, OPEN).content).not.toMatch(/All three rounds by/);
  });

  it("switches to the ran-out line once it has", () => {
    const panel = roundPanel(
      dancer({ registeredAt: "2026-11-16T00:00:00.000Z" }),
      0,
      CTX,
      new Date("2027-03-30T00:00:00Z"),
    );
    expect(panel.content).toMatch(/ran out/);
    expect(panel.content).toMatch(/Talk to a director/);
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

  /** And there is no longer any such thing as too late to start. */
  it("lets them start whenever, with nothing shared to run into", async () => {
    const { env } = envWith(Object.fromEntries([seed(assigned())]));
    const result = await startWindow(
      env,
      "100",
      2,
      TIMELINE,
      POLICY,
      new Date("2027-06-09T12:00:00Z"),
    );
    expect(result.ok).toBe(true);
  });

  /** Round 1 only, and the panel reads as good news rather than a refusal. */
  /**
   * The whole ordering, end to end: a cover, feedback, a piece, a start. The
   * feedback is the gate, so the piece can't even be put up before it.
   */
  it("runs cover -> score -> feedback -> piece -> read -> start, in that order", async () => {
    const { env } = envWith();
    const joined = new Date("2026-11-16T10:00:00Z");
    await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, joined);
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

    // Two verdicts are no longer enough to release a pass: it waits for the
    // piece as well, so the one message they get has everything behind it.
    expect(second.ok && second.record.document?.deliveredAt).toBeUndefined();
    expect(second.ok && second.warning).toMatch(/piece is up/);

    // The piece is what sends it.
    const up = await assignPiece(env, "100", 1, "https://piece", TARGET, TIMELINE, POLICY, reviewed);
    expect(up.ok).toBe(true);
    expect(up.ok && up.record.document?.deliveredAt).toBe(reviewed.toISOString());

    // And the start button on that message works the moment it lands — there is
    // no step between the pass and the piece any more.
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
      seed(dancer({ discordId: "4", rounds: { 1: { outcome: "failed" } } })),
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

  /**
   * The last-chance nudge went with the close date it counted back from. What's
   * left is the heads-up, which counts from the assignment — a fact about them
   * rather than about a calendar nobody shares any more.
   */
  it("says nothing about a cliff, because there isn't one", async () => {
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
    // Two days in: too early even for the heads-up, and there is nothing else.
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2027-01-07T00:00:00Z")),
    ).toEqual(quiet);

    // Ten days in, and the only thing that fires is the heads-up.
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2027-01-15T00:00:00Z")),
    ).toEqual({ ...quiet, headsUp: 1 });
    expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/waiting 10 days/);
    expect(sendDirectMessage.mock.calls[0]![2].content!).not.toMatch(/last chance|close/i);
  });

  /**
   * The one nobody else can reach: registered, never submitted, no window to
   * key off and no piece to wait on.
   */
  /**
   * Only reachable through `/diamonds add` now — registering is sending the
   * cover, so a dancer can't put themselves in this state. Kept because someone
   * a director added is the person least likely to know what they owe.
   */
  it("nudges somebody a director added who hasn't sent a cover", async () => {
    const { env } = envWith(Object.fromEntries([seed(dancer({ registeredAt: "2026-11-20T00:00:00.000Z" }))]));
    expect(
      await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-11-29T00:00:00Z")),
    ).toEqual(quiet);

    const due = new Date("2026-11-30T00:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, due)).toEqual({ ...quiet, round0: 1 });
    const said = sendDirectMessage.mock.calls[0]![2].content!;
    expect(said).toMatch(/haven't got a cover from you/);
    // Says why they didn't register themselves, because that's the confusing part.
    expect(said).toMatch(/A director put you on/);
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, due)).toEqual(quiet);
  });

  it("leaves a returning Diamond out of the Round 0 nudge — they owe nothing", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ cohort: "returning", registeredAt: "2026-11-20T00:00:00.000Z" })),
      ]),
    );
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
      Object.fromEntries([
        seed(
          dancer({
            cohort: "returning",
            rounds: { 0: bothPass(), 1: { assignedPiece: "https://piece" } },
            ...sealed,
          }),
        ),
      ]),
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
  it("names no dates at all, because there aren't any", () => {
    const panel = statusPanel(dancer(), 0, CTX, OPEN);
    expect(panel.content).toMatch(/Where everything stands/);
    // No date of any kind — a Discord timestamp is how every date here renders.
    expect(panel.content).not.toMatch(/<t:\d+/);
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

    // No upper bound any more: a date months out is a reasonable plan for
    // someone renewing, and the only clock it could meet is their own date.
    expect((await planStart(env, "100", 1, "2027-06-09", TIMELINE, POLICY, now)).ok).toBe(true);

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

  /**
   * A pass with its Round 1 piece already up, which is what releases it. The
   * piece going up is now the thing that sends the feedback, so a fixture
   * without one is a document that is still correctly being held.
   */
  const ready = (over: Partial<DiamondsRecord> = {}) =>
    dancer({
      cohort: "returning",
      rounds: { 0: bothPass(), 1: { assignedPiece: "https://piece" } },
      ...sealed,
      ...over,
    });

  /** Delivery is the gate, so an undelivered one must not open anything. */
  it("leaves them in Round 0 when the DM fails, and says so", async () => {
    sendDirectMessage.mockResolvedValueOnce(false);
    const { env } = envWith(Object.fromEntries([seed(ready())]));
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
  /**
   * The pass arrives whole — verdict and reasons — and the button is for the
   * next round rather than for the document. Nothing a dancer is owed sits
   * behind a click; what they choose the moment of is opening Round 1.
   */
  it("sends the pass, the document and the start button as one message", async () => {
    const { env } = envWith(Object.fromEntries([seed(ready())]));
    await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);

    const sent = sendDirectMessage.mock.calls[0]![2];
    expect(sent.content!).toMatch(/you're through to Round 1/i);
    expect(sent.content!).toContain("clean lines");

    // The real start button, not a step in front of it. Two earlier versions
    // put a click between the pass and the piece; this is the one that was
    // always going to matter.
    expect(JSON.stringify(sent.components)).toContain("dia|start|1");
    // And the warning that goes with it, because pressing it starts the clock.
    expect(sent.content!).toMatch(/starts your clock/);
    expect(sent.content!).toMatch(/no way to un-press it/);

    // Round 1 is open on delivery now, so the button is live the moment it lands.
    const delivered = (await getRecord(env, "100"))!;
    expect(roundOf(delivered, 0).outcome).toBe("passed");
    expect(activeRound(delivered, OPEN)).toEqual({ ok: true, round: 1 });
    expect((await startWindow(env, "100", 1, TIMELINE, POLICY, REVIEWED)).ok).toBe(true);
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
    const sent = sendDirectMessage.mock.calls[0]![2];
    expect(sent.content!).toMatch(/not taking this one through/);

    // Everything at once, unlike a pass. A pass holds the document because
    // opening it starts Round 1; a fail opens nothing, so a button in front of
    // the reasons would be a hoop for its own sake.
    expect(sent.content!).toContain("clean lines");
    // No start button either: there's no Round 1 for them to start.
    expect(JSON.stringify(sent.components)).not.toContain("dia|start");

    // And the offer to dance the rest anyway, which is theirs to take.
    expect(JSON.stringify(sent.components)).toContain("dia|practice|me");

    const record = (await getRecord(env, "100"))!;
    expect(roundOf(record, 0).outcome).toBe("failed");
    expect(activeRound(record, OPEN).ok).toBe(false);
  });

  /** Taking that offer puts two unjudged rounds after the fail. */
  it("lets them dance the rest as practice after a fail", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          dancer({
            cohort: "returning",
            document: feedbackSent(),
            rounds: { 0: { resultSentAt: "a", outcome: "failed" } },
          }),
        ),
      ]),
    );
    const taken = await takePractice(env, "100");
    expect(taken.ok).toBe(true);
    expect(taken.ok && taken.record.practiceFrom).toBe(1);

    // Round 0's fail stands, and the audition carries on past it.
    const after = (await getRecord(env, "100"))!;
    expect(roundOf(after, 0).outcome).toBe("failed");
    expect(activeRound(after, OPEN)).toEqual({ ok: true, round: 1 });

    // Costs nothing: they can register for a real one whenever they like.
    expect(
      (await register(env, "100", "Ada", "returning", undefined, TIMELINE, POLICY, LATER)).ok,
    ).toBe(true);
  });

  it("offers that to nobody else", async () => {
    const { env } = envWith(Object.fromEntries([seed(ready())]));
    const result = await takePractice(env, "100");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/isn't one/);
  });

  /**
   * And written before either of them has decided, it waits rather than being
   * refused — which is the normal order, since the moment to write it is while
   * you're watching.
   */
  it("holds a document written before Round 0 was called", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ cohort: "returning", rounds: { 1: { assignedPiece: "https://piece" } }, ...sealed })),
      ]),
    );
    const held = await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    expect(held.ok && held.warning).toMatch(/held/);
    expect(sendDirectMessage).not.toHaveBeenCalled();

    await scoreRound(env, "100", "d1", { verdict: "pass" }, POLICY, OPEN);
    const second = await scoreRound(env, "100", "d2", { verdict: "pass" }, POLICY, OPEN);
    expect(second.ok && second.record.document?.deliveredAt).toBe(OPEN.toISOString());
  });

  /** And holds a pass whose piece isn't up yet, which is the new wait. */
  it("holds a decided pass until Round 1's piece is up", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(dancer({ cohort: "returning", rounds: { 0: bothPass() } }))]),
    );
    const waiting = await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, OPEN);
    expect(waiting.ok && waiting.warning).toMatch(/piece is up/);
    expect(sendDirectMessage).not.toHaveBeenCalled();

    const up = await assignPiece(env, "100", 1, "https://piece", TARGET, TIMELINE, POLICY, REVIEWED);
    expect(up.ok && up.record.document?.deliveredAt).toBe(REVIEWED.toISOString());
    // One message, not two — the notice is what tells them the piece exists.
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/piece is ready when you are/);
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

/**
 * Practice, both ways in.
 *
 * Written as two sequences rather than a pile of unit tests because practice
 * isn't one rule — it's the verdict, the outcome model, the retry wait, the
 * membership and the result wording all agreeing to do nothing, and each of
 * those was decided separately. These are the tests that fail if any one of
 * them starts deciding something after all.
 */
describe("practice, asked for at the door", () => {
  /** Comfortably past the bar, so "practice doesn't pass" is the only reason it doesn't. */
  const eights = {
    technicality: 8,
    execution: 8,
    performance: 8,
    musicality: 8,
  } as const;
  const doc = {
    content: "Good season.",
    strengths: ["clean lines", "good pockets", "committed"],
    growthAreas: ["arms"],
  };

  it("runs all three rounds with nothing decided in any of them", async () => {
    const { env } = envWith();
    const joined = new Date("2026-11-16T10:00:00Z");
    await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, joined, true);
    expect((await getRecord(env, "100"))!.practiceFrom).toBe(0);

    await submit(env, "100", 0, "https://cover", TIMELINE, POLICY, joined);

    // Round 0 has no verdict to wait for, so the document *is* the round and
    // goes the moment it's written. Nobody has called anything.
    const filed = await fileFeedback(env, "100", doc, "d1", TIMELINE, POLICY, joined);
    expect(filed.ok && filed.warning).toBeUndefined();
    const zero = (await getRecord(env, "100"))!;
    expect(roundOf(zero, 0).outcome).toBe("practice");
    expect(roundOf(zero, 0).ballots).toBeUndefined();
    // And it ends nothing: they're still going.
    expect(activeRound((await getRecord(env, "100"))!, joined)).toEqual({ ok: true, round: 1 });

    // Round 1 still gets scored, because the scores are what the feedback is
    // built from — they just don't decide anything.
    const reviewed = new Date("2026-11-20T10:00:00Z");
    await assignPiece(env, "100", 1, "https://piece", TARGET, TIMELINE, POLICY, joined);
    await startWindow(env, "100", 1, TIMELINE, POLICY, joined);
    await submit(env, "100", 1, "https://mine", TIMELINE, POLICY, joined);
    await scoreRound(env, "100", "d1", { targetScore: 4 }, POLICY, reviewed);
    await scoreRound(env, "100", "d2", { targetScore: 4 }, POLICY, reviewed);

    const sent = await sendResult(env, "100", DIRECTORS, CTX, POLICY, reviewed);
    expect(sent.ok && sent.outcome).toBe("practice");
    const said = sendDirectMessage.mock.calls.at(-1)![2].content!;
    expect(said).toMatch(/practice/i);
    expect(said).not.toMatch(/through to Round 2|not through/i);

    // A target score of 4 against a before of 4 would have been a fail.
    expect(activeRound((await getRecord(env, "100"))!, reviewed)).toEqual({ ok: true, round: 2 });
  });

  it("gives them no membership, no role and no wait at the end", async () => {
    const { env } = envWith({
      "config:role.diamonds": "role-diamonds",
      ...Object.fromEntries([
        seed(
          dancer({
            practiceFrom: 0,
            document: feedbackSent(),
            rounds: {
              0: { submittedAt: "a", resultSentAt: "b", outcome: "practice" },
              1: { submittedAt: "c", resultSentAt: "d", outcome: "practice" },
              2: {
                assignedPiece: "https://final",
                submittedAt: "2026-11-22T00:00:00.000Z",
                ballots: {
                  d1: { scores: { ...eights }, at: "2026-11-23T00:00:00.000Z" },
                  d2: { scores: { ...eights }, at: "2026-11-23T00:00:00.000Z" },
                },
              },
            },
            ...sealed,
          }),
        ),
      ]),
    });

    const sent = await sendResult(env, "100", DIRECTORS, CTX, POLICY, new Date("2026-11-24T12:00:00Z"));
    expect(sent.ok && sent.outcome).toBe("practice");

    const stored = (await getRecord(env, "100"))!;
    // Eights would have sailed past the bar. Practice doesn't pass.
    expect(stored.memberSince).toBeUndefined();
    expect(stored.enforcedAt).toBeUndefined();
    expect(addRole).not.toHaveBeenCalled();

    // And they can go again straight away — practice costs nothing, which is
    // the deal. A wait here would make asking for it the riskier choice.
    expect(
      (await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, new Date("2026-11-25T00:00:00Z"))).ok,
    ).toBe(true);
    const again = (await getRecord(env, "100"))!;
    expect(again.history).toHaveLength(1);
    expect(again.practiceFrom).toBeUndefined();
  });
});

describe("carrying a failed Round 1 on as practice", () => {
  /** A Round 1 both of them have scored, and it didn't move. */
  const stuck = (over: Partial<DiamondsRecord> = {}): DiamondsRecord =>
    dancer({
      document: feedbackSent(),
      rounds: {
        0: zeroPassed(),
        1: {
          assignedPiece: "https://piece",
          submittedAt: "2026-11-19T00:00:00.000Z",
          ballots: {
            d1: { targetScore: 4, at: "2026-11-20T00:00:00.000Z" },
            d2: { targetScore: 4, at: "2026-11-20T00:00:00.000Z" },
          },
        },
      },
      ...sealed,
      ...over,
    });

  const now = new Date("2026-11-21T10:00:00Z");

  it("keeps the fail and keeps them going", async () => {
    const { env } = envWith(Object.fromEntries([seed(stuck())]));
    expect((await carryAsPractice(env, "100", POLICY)).ok).toBe(true);

    const carried = (await getRecord(env, "100"))!;
    expect(carried.practiceFrom).toBe(2);

    const sent = await sendResult(env, "100", DIRECTORS, CTX, POLICY, now);
    // The round still failed. Both facts are kept, because both are true.
    expect(sent.ok && sent.outcome).toBe("failed");
    const said = sendDirectMessage.mock.calls.at(-1)![2].content!;
    expect(said).toMatch(/didn't move enough/);
    expect(said).toMatch(/as practice/);

    // And the audition doesn't end on it.
    const after = (await getRecord(env, "100"))!;
    expect(roundOf(after, 1).outcome).toBe("failed");
    expect(activeRound(after, now)).toEqual({ ok: true, round: 2 });
  });

  it("offers the branch on the card, and only on a fail", () => {
    const labels = (record: DiamondsRecord, round: Round) =>
      JSON.stringify(reviewCard(record, round, tally(roundOf(record, round), 2), settleRound(record, round, POLICY), {
        minScores: 2,
        weights: DEFAULT_WEIGHTS,
        bar: 7.5,
        floor: 6,
        commandChannel: "diamonds-bot",
      }).components);

    expect(labels(stuck(), 1)).toContain("Carry on as practice");
    // Advanced: nothing to carry them out of.
    const moved = stuck({
      rounds: {
        ...stuck().rounds,
        1: {
          ...stuck().rounds[1]!,
          ballots: {
            d1: { targetScore: 9, at: "2026-11-20T00:00:00.000Z" },
            d2: { targetScore: 9, at: "2026-11-20T00:00:00.000Z" },
          },
        },
      },
    });
    expect(labels(moved, 1)).not.toContain("Carry on as practice");
    // Already practice: there is nowhere to carry them to.
    expect(labels(stuck({ practiceFrom: 0 }), 1)).not.toContain("Carry on as practice");
  });

  it("refuses once they've already been told", async () => {
    const told = stuck();
    told.rounds[1]!.resultSentAt = "2026-11-20T12:00:00.000Z";
    told.rounds[1]!.outcome = "failed";
    const { env } = envWith(Object.fromEntries([seed(told)]));
    const result = await carryAsPractice(env, "100", POLICY);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/already been told/);
  });

  it("still ends in no wait, because Round 2 was practice", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          stuck({
            practiceFrom: 2,
            rounds: {
              0: zeroPassed(),
              1: { submittedAt: "a", resultSentAt: "b", outcome: "failed" },
              2: { submittedAt: "c", resultSentAt: "d", outcome: "practice" },
            },
          }),
        ),
      ]),
    );
    expect(
      (await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, new Date("2026-12-01T00:00:00Z"))).ok,
    ).toBe(true);
  });
});

/**
 * The two-month clock.
 *
 * The only deadline left, and the one kind that fits a rolling process: it
 * belongs to one person, counted from their own registration, so it can't make
 * anybody wait for anybody else. Tested as a sequence because the warning, the
 * close, the two refusals and the wait are five rules that have to agree about
 * one date.
 */
describe("the two-month clock", () => {
  const JOINED = "2026-11-16T00:00:00.000Z";
  /**
   * Mid-run and waiting on a piece, so the only thing the sweep can have to say
   * is about the clock — the heads-up needs an assigned piece, and it would
   * otherwise win under the one-message-a-day rule and hide what's being tested.
   */
  const running = (over: Partial<DiamondsRecord> = {}): DiamondsRecord =>
    dancer({
      registeredAt: JOINED,
      document: feedbackSent(),
      rounds: { 0: zeroPassed() },
      ...sealed,
      ...over,
    });

  it("warns once when there are ten days left", () => {
    expect(runEndsAt(running(), 60)).toBe("2027-01-15T00:00:00.000Z");
    expect(runDaysLeft(running(), 60, new Date("2027-01-04T00:00:00Z"))).toBe(11);
  });

  it("sends that warning, and only once", async () => {
    const { env } = envWith(Object.fromEntries([seed(running())]));
    const tenOut = new Date("2027-01-05T12:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, tenOut)).toEqual({
      ...quiet,
      warned: 1,
    });
    const said = sendDirectMessage.mock.calls[0]![2].content!;
    expect(said).toMatch(/days left on your audition/);
    expect(said).toMatch(/ask a director/i);
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, tenOut)).toEqual(quiet);
  });

  it("closes the audition when the clock runs out, and tells everyone", async () => {
    const { env } = envWith(Object.fromEntries([seed(running())]));
    const after = new Date("2027-01-16T12:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, after)).toEqual({
      ...quiet,
      expired: 1,
    });

    const stored = (await getRecord(env, "100"))!;
    expect(stored.expiredAt).toBe(after.toISOString());
    expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/audition has closed/);
    expect(alertDirectors.mock.calls[0]![1]).toMatch(/audition has closed/);
    // Points the directors at the way back, because there is one.
    expect(alertDirectors.mock.calls[0]![1]).toMatch(/diamonds add/);

    // Once. The record carries the fact, so tomorrow's sweep says nothing.
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, after)).toEqual(quiet);
  });

  it("refuses a start and a submission once it has run out", async () => {
    const { env } = envWith(Object.fromEntries([seed(running())]));
    const after = new Date("2027-01-16T12:00:00Z");

    const started = await startWindow(env, "100", 1, TIMELINE, POLICY, after);
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.reason).toMatch(/ran out/);
    expect(started.ok === false && started.reason).toMatch(/Talk to a director/);

    const sent = await submit(env, "100", 0, "https://cover", TIMELINE, POLICY, after);
    expect(sent.ok).toBe(false);
  });

  /** Running out costs what dropping out costs, for the same reason. */
  it("charges the six-month wait from the day it closed", async () => {
    const { env } = envWith(
      Object.fromEntries([seed(running({ expiredAt: "2027-01-16T12:00:00.000Z" }))]),
    );
    const soon = await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, new Date("2027-03-01T00:00:00Z"));
    expect(soon.ok).toBe(false);
    expect(soon.ok === false && soon.reason).toMatch(/6-month wait/);

    expect(
      (await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, new Date("2027-07-20T00:00:00Z"))).ok,
    ).toBe(true);
  });

  /** But not for a run nobody was judging. */
  it("charges nothing when the run was practice", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(running({ practiceFrom: 0, expiredAt: "2027-01-16T12:00:00.000Z" })),
      ]),
    );
    expect(
      (await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, new Date("2027-02-01T00:00:00Z"))).ok,
    ).toBe(true);
  });

  it("leaves a finished audition alone, however long ago it finished", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(
          running({
            rounds: {
              0: zeroPassed(),
              1: { submittedAt: "a", resultSentAt: "b", outcome: "advanced" },
              2: { submittedAt: "c", resultSentAt: "d", outcome: "passed" },
            },
          }),
        ),
      ]),
    );
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2027-06-16T12:00:00Z"))).toEqual(
      quiet,
    );
    expect((await getRecord(env, "100"))!.expiredAt).toBeUndefined();
  });

  /**
   * And invents nothing for a record written before this existed. A deadline
   * somebody was never told about is worse than no deadline.
   */
  it("gives no clock to a record with no registration date", async () => {
    const { env } = envWith(Object.fromEntries([seed(running({ registeredAt: undefined }))]));
    expect(runEndsAt(running({ registeredAt: undefined }), 60)).toBeUndefined();
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2027-06-16T12:00:00Z"))).toEqual(
      quiet,
    );
  });

  /**
   * A director's extra days move the date rather than making a second clock,
   * and they're kept one grant at a time so the total has an audit trail
   * behind it.
   */
  it("counts a director's added days", () => {
    const granted = (...days: number[]) =>
      running({
        runExtensions: days.map((one) => ({
          days: one,
          reason: "injury",
          by: "d1",
          at: "2027-01-10T00:00:00.000Z",
        })),
      });
    expect(runEndsAt(granted(14), 60)).toBe("2027-01-29T00:00:00.000Z");
    expect(runExpired(granted(14), 60, new Date("2027-01-20T00:00:00Z"))).toBe(false);
    // Two grants add up.
    expect(runEndsAt(granted(14, 7), 60)).toBe("2027-02-05T00:00:00.000Z");
  });

  describe("extending the run", () => {
    it("moves the date and tells them", async () => {
      const { env } = envWith(Object.fromEntries([seed(running())]));
      const result = await extendRun(env, "100", 14, "injury", "d1", POLICY, new Date("2027-01-10T00:00:00Z"));
      expect(result.ok).toBe(true);
      expect(runEndsAt((await getRecord(env, "100"))!, 60)).toBe("2027-01-29T00:00:00.000Z");
      expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/14 more days/);
    });

    /**
     * The reason it exists. The refusal a dancer sees when the clock runs out
     * says "talk to a director", so a director has to be able to act on that —
     * and they pick up mid-round rather than starting over.
     */
    it("reopens an audition that already closed", async () => {
      const { env } = envWith(
        Object.fromEntries([seed(running({ expiredAt: "2027-01-16T12:00:00.000Z" }))]),
      );
      const result = await extendRun(env, "100", 21, "was in hospital", "d1", POLICY, new Date("2027-01-18T00:00:00Z"));
      expect(result.ok).toBe(true);

      const stored = (await getRecord(env, "100"))!;
      expect(stored.expiredAt).toBeUndefined();
      expect(runExpired(stored, 60, new Date("2027-01-19T00:00:00Z"))).toBe(false);
      expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/open again/);
      // And the wait it was charging is gone with it.
      expect(
        (await register(env, "100", "Ada", "new", COVER, TIMELINE, POLICY, new Date("2027-01-19T00:00:00Z"))).ok,
      ).toBe(true);
    });

    /** The warning can fire again, so an extension doesn't cost them one. */
    it("lets the ten-day warning come round again", async () => {
      const { env } = envWith(
        Object.fromEntries([seed(running({ runWarnedAt: "2027-01-05T12:00:00.000Z" }))]),
      );
      await extendRun(env, "100", 14, "injury", "d1", POLICY, new Date("2027-01-10T00:00:00Z"));
      expect((await getRecord(env, "100"))!.runWarnedAt).toBeUndefined();

      sendDirectMessage.mockClear();
      const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2027-01-20T12:00:00Z"));
      expect(run.warned).toBe(1);
    });

    it("refuses days that still leave them past the date", async () => {
      const { env } = envWith(
        Object.fromEntries([seed(running({ expiredAt: "2027-01-16T12:00:00.000Z" }))]),
      );
      const result = await extendRun(env, "100", 1, "injury", "d1", POLICY, new Date("2027-02-01T00:00:00Z"));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/enough to actually finish/);
    });

    it("refuses an audition that's already been decided", async () => {
      const { env } = envWith(
        Object.fromEntries([
          seed(
            running({
              rounds: { 1: { submittedAt: "a", resultSentAt: "b", outcome: "failed" } },
            }),
          ),
        ]),
      );
      const result = await extendRun(env, "100", 14, "x", "d1", POLICY, new Date("2027-01-10T00:00:00Z"));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/diamonds add/);
    });
  });
});

/**
 * An enforcement date landing in the middle of a re-audition.
 *
 * The date asks for a re-audition; somebody mid-re-audition is answering it.
 * Taking the role off them on Jan 1 would be the bot failing to notice its own
 * question being answered — so nothing is reassessed until that audition ends,
 * and then it is reassessed on the spot.
 */
describe("a date that lands mid-audition", () => {
  const renewing = (over: Partial<DiamondsRecord> = {}): DiamondsRecord =>
    dancer({
      memberSince: "2027-11-15T00:00:00.000Z",
      enforcedAt: "2029-01-01T05:00:00.000Z",
      // Registered again in December, with the date eleven days out.
      registeredAt: "2028-12-20T00:00:00.000Z",
      history: [{ rounds: {}, outcome: "passed", finishedAt: "2027-11-15T00:00:00.000Z" }],
      rounds: { 0: { submittedAt: "2028-12-22T00:00:00.000Z" } },
      ...over,
    });

  const ROLE = { "config:role.diamonds": "role-diamonds" };

  it("takes nothing off them on the day itself", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(renewing())]) });
    const theDay = new Date("2029-01-01T12:00:00Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, theDay)).toEqual(quiet);
    expect(removeRole).not.toHaveBeenCalled();
    expect((await getRecord(env, "100"))!.lapsedAt).toBeUndefined();
  });

  /** Nor a fortnight later, while they're still going. */
  it("leaves them alone for as long as the audition is live", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(renewing())]) });
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-15T12:00:00Z"))).toEqual(
      quiet,
    );
    expect(removeRole).not.toHaveBeenCalled();
  });

  /** And says nothing about renewing, either — they're doing it. */
  it("sends no renewal notice while it's live", async () => {
    const { env } = envWith({ ...ROLE, ...Object.fromEntries([seed(renewing())]) });
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2028-12-28T12:00:00Z"))).toEqual(
      quiet,
    );
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  /**
   * The deferral ends with the audition, not with a grace period — so a
   * withdrawal puts them straight back in front of a date that has already
   * gone. That's the rule that stops "drop it and keep the role" working.
   */
  it("revokes as soon as they drop it", async () => {
    const { env } = envWith({
      ...ROLE,
      ...Object.fromEntries([seed(renewing({ withdrawnAt: "2029-01-10T00:00:00.000Z" }))]),
    });
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-11T12:00:00Z"));
    expect(run.lapsed).toBe(1);
    expect(removeRole).toHaveBeenCalledWith(env, "g-dance", "100", "role-diamonds");
    // The DM names the date it ran to rather than claiming it was today.
    expect(sendDirectMessage.mock.calls[0]![2].content!).toMatch(/ran to <t:\d+:D>/);
  });

  /** Same the moment the two-month clock closes it. */
  it("revokes when the run closes instead", async () => {
    const { env } = envWith({
      ...ROLE,
      ...Object.fromEntries([seed(renewing({ expiredAt: "2029-02-18T00:00:00.000Z" }))]),
    });
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-02-19T12:00:00Z"));
    expect(run.lapsed).toBe(1);
  });

  /** A pass moves the date instead, so there's nothing left to revoke. */
  it("moves the date on a pass, with no gap in between", async () => {
    const { env } = envWith({
      ...ROLE,
      ...Object.fromEntries([
        seed(
          renewing({
            ...sealed,
            document: feedbackSent("2028-12-23T00:00:00.000Z"),
            rounds: {
              0: { submittedAt: "a", resultSentAt: "b", outcome: "passed" },
              1: { submittedAt: "c", resultSentAt: "d", outcome: "advanced" },
              2: {
                submittedAt: "2029-01-05T00:00:00.000Z",
                ballots: {
                  d1: { scores: { technicality: 8, execution: 8, performance: 8, musicality: 8 }, at: "e" },
                  d2: { scores: { technicality: 8, execution: 8, performance: 8, musicality: 8 }, at: "e" },
                },
              },
            },
          }),
        ),
      ]),
    });

    // Their date has already gone by, and they still have the role.
    const sent = await sendResult(env, "100", DIRECTORS, CTX, POLICY, new Date("2029-01-06T12:00:00Z"));
    expect(sent.ok && sent.outcome).toBe("passed");

    const stored = (await getRecord(env, "100"))!;
    // Passing in January puts them on the next Jan 1, by the usual table.
    expect(stored.enforcedAt).toBe("2030-01-01T05:00:00.000Z");
    expect(await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-07T12:00:00Z"))).toEqual(
      quiet,
    );
    expect(removeRole).not.toHaveBeenCalled();
  });

  /** A fail hands them back to a date that has gone, which takes effect at once. */
  it("revokes right after a failed verdict", async () => {
    const { env } = envWith({
      ...ROLE,
      ...Object.fromEntries([
        seed(
          renewing({
            rounds: { 1: { submittedAt: "a", resultSentAt: "2029-01-06T00:00:00.000Z", outcome: "failed" } },
          }),
        ),
      ]),
    });
    const run = await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2029-01-07T12:00:00Z"));
    expect(run.lapsed).toBe(1);
  });
});

/**
 * The clock measures the dancer's half of the process.
 *
 * Both of these are about the same hole: the 60 days used to include the
 * directors' turnaround, so a submission on day 58 could expire while the only
 * outstanding work was two people watching a video.
 */
describe("whose time the clock is counting", () => {
  const JOINED = "2026-11-16T00:00:00.000Z";

  it("stops once Round 2 is in, however long the review takes", () => {
    const submitted = dancer({
      registeredAt: JOINED,
      document: feedbackSent(),
      rounds: {
        0: zeroPassed(),
        1: { submittedAt: "a", resultSentAt: "b", outcome: "advanced" },
        2: { submittedAt: "2027-01-14T00:00:00.000Z" },
      },
      ...sealed,
    });
    // Day 59 of 60, then two months later. Neither expires: they owe nothing.
    expect(runExpired(submitted, 60, new Date("2027-01-14T12:00:00Z"))).toBe(false);
    expect(runExpired(submitted, 60, new Date("2027-03-14T12:00:00Z"))).toBe(false);
  });

  it("keeps running while the next move is theirs", () => {
    const waiting = dancer({
      registeredAt: JOINED,
      document: feedbackSent(),
      rounds: { 0: zeroPassed(), 1: { assignedPiece: "https://p" } },
      ...sealed,
    });
    expect(runExpired(waiting, 60, new Date("2027-01-16T12:00:00Z"))).toBe(true);
  });

  /**
   * And the directors get told when they're the ones holding it up. Daily
   * rather than once, because unlike every dancer-facing message here this is
   * about work still outstanding — it stops when the list empties.
   */
  it("tells the directors what they owe beyond the promised turnaround", async () => {
    const { env } = envWith(
      Object.fromEntries([
        // Submitted eight days ago against a five-day promise.
        seed(dancer({ discordId: "1", registeredAt: JOINED, rounds: { 0: { submittedAt: "2026-11-20T00:00:00.000Z" } } })),
        // And one from yesterday, which is not late.
        seed(dancer({ discordId: "2", registeredAt: JOINED, rounds: { 0: { submittedAt: "2026-11-27T00:00:00.000Z" } } })),
      ]),
    );
    await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-11-28T12:00:00Z"));

    const alert = alertDirectors.mock.calls.at(-1)![1];
    expect(alert).toMatch(/1 waiting on a ballot/);
    expect(alert).toContain("<@1>");
    expect(alert).not.toContain("<@2>");
    // Names the stake, because the dancer's clock is still running.
    expect(alert).toMatch(/60 days keep running/);
  });

  it("says nothing on a morning when nothing is late", async () => {
    const { env } = envWith(
      Object.fromEntries([
        seed(dancer({ registeredAt: JOINED, rounds: { 0: { submittedAt: "2026-11-27T00:00:00.000Z" } } })),
      ]),
    );
    await runDiamondsSweep(env, TIMELINE, POLICY, new Date("2026-11-28T12:00:00Z"));
    expect(alertDirectors).not.toHaveBeenCalled();
  });
});
