import { describe, expect, it, vi } from "vitest";
import {
  buildIntakeMessage,
  buildOpenRowResponse,
  customId,
  isDancer,
  parseCustomId,
  type CardOptions,
  type CardState,
} from "../src/applications/card";
import {
  emptyDecision,
  type Ballot,
  type Decision,
} from "../src/applications/decision";
import type { InterviewRecord } from "../src/applications/interviewSlot";
import { parseRow } from "../src/applications/fields";
import type { MessagePayload } from "../src/discord/types";
import type { VideoGroup } from "../src/applications/videos";

/**
 * Column indices: C=2 email, D=3 type, E=4 name, G=6 age, H=7 location, I=8
 * subunits, K=10 transportation, P=15 feedback, AL=37 method, AM..AP=38..41
 * videos, AQ=42 availability.
 */
function makeRow(opts: {
  type?: string;
  name?: string;
  method?: string;
  fields?: Partial<Record<"G" | "H" | "I" | "K" | "P" | "AQ", string>>;
  videos?: Partial<Record<"AM" | "AN" | "AO" | "AP", string>>;
} = {}) {
  const values = new Array(50).fill("");
  values[0] = "2026-09-01 10:00";
  values[2] = "a@b.com";
  values[3] = opts.type ?? "Dancer";
  values[4] = opts.name ?? "Mimi";
  values[37] = opts.method ?? "Existing dance video submission and interview";
  const at: Record<string, number> = {
    G: 6, H: 7, I: 8, K: 10, P: 15,
    AM: 38, AN: 39, AO: 40, AP: 41, AQ: 42,
  };
  for (const [col, text] of Object.entries({ ...opts.fields, ...opts.videos })) {
    values[at[col] as number] = text;
  }
  return parseRow(12, values);
}

const opts = (over: Partial<CardOptions> = {}): CardOptions => ({
  videos: [],
  state: "open",
  ...over,
});

const embedJson = (msg: MessagePayload) => JSON.stringify(msg.embeds);
const firstEmbedDescription = (msg: MessagePayload): string => {
  const embed = (msg.embeds as { description?: string }[] | undefined)?.[0];
  if (!embed?.description) throw new Error("no embed description");
  return embed.description;
};

describe("custom ids", () => {
  it("round-trips and survives the token expiry by carrying the row", () => {
    expect(parseCustomId(customId("open", 12))).toEqual({ action: "open", row: 12 });
    expect(parseCustomId(customId("reopen", 12))).toEqual({ action: "reopen", row: 12 });
    expect(customId("reopen", 12).length).toBeLessThanOrEqual(100);
  });

  it("rejects foreign or malformed ids", () => {
    expect(parseCustomId("something|else|3")).toBeNull();
    expect(parseCustomId("app|open|nope")).toBeNull();
    expect(parseCustomId("app|open|1")).toBeNull();
    expect(parseCustomId("app|delete|12")).toBeNull();
  });
});

describe("isDancer", () => {
  it("matches case-insensitively inside a longer answer", () => {
    expect(isDancer("Dancer")).toBe(true);
    expect(isDancer("dancer (Hearts)")).toBe(true);
    expect(isDancer("Videographer")).toBe(false);
  });
});

describe("buildIntakeMessage — routing", () => {
  it("gives a dancer a card with an Open row button", () => {
    const msg = buildIntakeMessage(makeRow(), opts());
    expect(msg.embeds).toHaveLength(1);
    expect(JSON.stringify(msg.components)).toContain("app|open|12");
  });

  it("gives a videographer one line, not a review card", () => {
    const msg = buildIntakeMessage(makeRow({ type: "Videographer / editor" }), opts());
    expect(msg.content).toContain("Mimi");
    expect(msg.embeds).toBeUndefined();
  });

  it("tells a videographer's card that the workflow ends there", () => {
    const msg = buildIntakeMessage(makeRow({ type: "Videographer / editor" }), opts());
    expect(msg.content).toContain("no review, no interview");
  });

  it("offers a videographer a reply draft and a sheet link, and nothing else", () => {
    const msg = buildIntakeMessage(
      makeRow({ type: "Videographer / editor" }),
      opts({ sheetUrl: "https://example.com/sheet" }),
    );
    const buttons = (msg.components as { components: { custom_id?: string; url?: string }[] }[])[0]
      ?.components;
    expect(buttons?.map((b) => b.custom_id ?? b.url)).toEqual([
      "app|reply|12",
      "https://example.com/sheet",
    ]);
  });

  it("omits the sheet button for a videographer when no sheet is configured", () => {
    const msg = buildIntakeMessage(makeRow({ type: "Videographer / editor" }), opts());
    const buttons = (msg.components as { components: unknown[] }[])[0]?.components;
    expect(buttons).toHaveLength(1);
  });

  it("shows an unrecognised applicant type in full rather than burying it", () => {
    const msg = buildIntakeMessage(makeRow({ type: "stage manager" }), opts());
    expect(msg.embeds).toHaveLength(1);
    expect(embedJson(msg)).toContain("Unrecognised applicant type");
  });
});

describe("audition method on the card", () => {
  it("names the video-submission method", () => {
    const msg = buildIntakeMessage(makeRow(), opts());
    expect(firstEmbedDescription(msg)).toContain("Existing dance video + interview");
  });

  it("warns when a video-submission applicant has no videos", () => {
    const msg = buildIntakeMessage(makeRow(), opts());
    expect(firstEmbedDescription(msg)).toContain("no video links found");
  });

  it("does not warn about missing videos for a RISK-process applicant", () => {
    const msg = buildIntakeMessage(
      makeRow({ method: "RISK Audition process" }),
      opts({ state: "awaiting" }),
    );
    const desc = firstEmbedDescription(msg);
    expect(desc).not.toContain("no video links found");
    expect(desc).toContain("Waiting on their audition form");
  });

  it("shows the closing date on an awaiting card", () => {
    const due = new Date("2026-09-24T00:00:00Z");
    const msg = buildIntakeMessage(
      makeRow({ method: "RISK Audition process" }),
      opts({ state: "awaiting", dueAt: due }),
    );
    expect(firstEmbedDescription(msg)).toContain(
      `<t:${Math.floor(due.getTime() / 1000)}:D>`,
    );
  });

  it("flags an unrecognised method and shows the raw answer", () => {
    const msg = buildIntakeMessage(makeRow({ method: "not sure yet" }), opts());
    const desc = firstEmbedDescription(msg);
    expect(desc).toContain("Unrecognised");
    expect(desc).toContain("not sure yet");
  });
});

describe("card states", () => {
  it("a closed card says so and offers Reopen", () => {
    const msg = buildIntakeMessage(
      makeRow({ method: "RISK Audition process" }),
      opts({ state: "closed" }),
    );
    expect(firstEmbedDescription(msg)).toContain("Closed");
    expect(JSON.stringify(msg.components)).toContain("app|reopen|12");
  });

  it("an open card has no Reopen button", () => {
    const msg = buildIntakeMessage(makeRow(), opts());
    expect(JSON.stringify(msg.components)).not.toContain("reopen");
  });

  it("a submitted card reports the submission", () => {
    const msg = buildIntakeMessage(
      makeRow({ method: "RISK Audition process" }),
      opts({ state: "submitted" }),
    );
    expect(firstEmbedDescription(msg)).toContain("Audition form submitted");
  });

  it("records the state in the footer", () => {
    const msg = buildIntakeMessage(makeRow(), opts({ state: "closed" }));
    expect(embedJson(msg)).toContain("· closed");
  });
});

describe("video groups on the card", () => {
  const groups: VideoGroup[] = [
    {
      label: "Boy Group — CREW",
      links: [{ url: "https://youtu.be/aaa", label: "", access: "public" }],
    },
    {
      label: "Girl Group — SOLO",
      links: [
        {
          url: "https://drive.google.com/file/d/1A/view",
          label: "heels",
          access: "restricted",
        },
      ],
    },
  ];

  it("keeps each column's category as a heading", () => {
    const desc = firstEmbedDescription(buildIntakeMessage(makeRow(), opts({ videos: groups })));
    expect(desc).toContain("**Boy Group — CREW**");
    expect(desc).toContain("**Girl Group — SOLO**");
  });

  it("flags restricted links and keeps in-cell annotations", () => {
    const desc = firstEmbedDescription(buildIntakeMessage(makeRow(), opts({ videos: groups })));
    expect(desc).toContain("restricted");
    expect(desc).toContain("heels");
  });
});

describe("card fields", () => {
  it("reads each field from its configured column", () => {
    const msg = buildIntakeMessage(
      makeRow({
        fields: {
          G: "19",
          H: "Tenleytown",
          I: "Hearts",
          K: "Metro",
          P: "Yes please",
          AQ: "Sat mornings",
        },
      }),
      opts(),
    );
    const fields = (msg.embeds as { fields: { name: string; value: string }[] }[])[0]?.fields;
    expect(fields).toEqual([
      { name: "Age", value: "19", inline: true },
      { name: "Location", value: "Tenleytown", inline: true },
      { name: "Transportation", value: "Metro", inline: true },
      { name: "Subunits", value: "Hearts", inline: false },
      { name: "Availability", value: "Sat mornings", inline: false },
      { name: "Feedback preference", value: "Yes please", inline: true },
    ]);
  });

  it("renders an empty answer as a dash rather than omitting the field", () => {
    const msg = buildIntakeMessage(makeRow({ fields: { G: "19" } }), opts());
    const fields = (msg.embeds as { fields: { value: string }[] }[])[0]?.fields;
    expect(fields?.[1]?.value).toBe("—");
  });

  it("warns on the card when a column is left unconfigured", async () => {
    vi.resetModules();
    vi.doMock("../src/config/columns", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/config/columns")>()),
      CARD_COLUMNS: [{ key: "age", label: "Age", column: null, inline: true }],
    }));

    const [{ buildIntakeMessage: build }, { parseRow: parse }] = await Promise.all([
      import("../src/applications/card"),
      import("../src/applications/fields"),
    ]);
    const values = new Array(50).fill("");
    values[3] = "Dancer";
    values[4] = "Mimi";

    expect(JSON.stringify(build(parse(12, values), opts()).embeds)).toContain(
      "Not configured in columns.ts",
    );
    vi.doUnmock("../src/config/columns");
    vi.resetModules();
  });
});

describe("buildOpenRowResponse", () => {
  it("skips empty cells and pairs headers with values", () => {
    const msg = buildOpenRowResponse(
      12,
      ["Timestamp", "Score", "Email Address", "Type", "Name"],
      ["2026-09-01", "", "a@b.com", "Dancer", "Mimi"],
    );
    const desc = firstEmbedDescription(msg);
    expect(desc).toContain("Email Address");
    expect(desc).not.toContain("Score");
  });

  it("stays inside the embed description limit on a long row", () => {
    const headers = Array.from({ length: 60 }, (_, i) => `Question ${i}`);
    const values = Array.from({ length: 60 }, () => "x".repeat(400));
    const desc = firstEmbedDescription(buildOpenRowResponse(12, headers, values));
    expect(desc.length).toBeLessThanOrEqual(4096);
    expect(desc).toContain("too long to show");
  });
});

describe("when decision buttons appear", () => {
  const withDecision = (state: CardState, decision = emptyDecision()) =>
    buildIntakeMessage(
      makeRow({
        method:
          state === "open" ? "Existing dance video submission and interview" : "RISK Audition process",
      }),
      opts({ state, decision, directorIds: ["d1", "d2"], minVotes: 2 }),
    );

  const buttonIds = (msg: MessagePayload): string[] =>
    (msg.components as { components: { custom_id?: string }[] }[] | undefined)
      ?.flatMap((row) => row.components)
      .map((b) => b.custom_id ?? "")
      .filter(Boolean) ?? [];

  it("hides them while a RISK-process applicant hasn't submitted", () => {
    const ids = buttonIds(withDecision("awaiting"));
    expect(ids).not.toContain("app|vote|12");
    expect(ids).toContain("app|open|12");
  });

  it("says voting opens once the audition arrives", () => {
    expect(firstEmbedDescription(withDecision("awaiting"))).toContain("Voting opens once it arrives");
  });

  it("shows them as soon as a RISK-process audition is submitted", () => {
    const ids = buttonIds(withDecision("submitted"));
    expect(ids).toEqual(expect.arrayContaining(["app|vote|12", "app|hold|12"]));
  });

  it("shows them immediately for an existing-links applicant", () => {
    const ids = buttonIds(withDecision("open"));
    expect(ids).toEqual(expect.arrayContaining(["app|vote|12", "app|feedback|12"]));
  });

  it("hides them on a closed card", () => {
    const ids = buttonIds(withDecision("closed"));
    expect(ids).not.toContain("app|vote|12");
    expect(ids).toContain("app|reopen|12");
  });
});

describe("split votes on the card", () => {
  const split = (over: Partial<Decision> = {}) =>
    buildIntakeMessage(
      makeRow(),
      opts({
        state: "open",
        decision: { ...emptyDecision(), ballots: { d1: ["Hearts"], d2: [] }, ...over },
        directorIds: ["d1", "d2"],
        minVotes: 2,
      }),
    );

  const buttons = (msg: MessagePayload) =>
    (msg.components as { components: { custom_id?: string; disabled?: boolean }[] }[])
      .flatMap((row) => row.components);

  it("locks the ballot and offers a recorded outcome instead", () => {
    const all = buttons(split());
    const vote = all.find((b) => b.custom_id === "app|vote|12");
    expect(vote?.disabled).toBe(true);
    expect(all.map((b) => b.custom_id)).toEqual(
      expect.arrayContaining(["app|final-yes|12", "app|final-no|12"]),
    );
  });

  it("leaves feedback available during the discussion", () => {
    const feedback = buttons(split()).find((b) => b.custom_id === "app|feedback|12");
    expect(feedback?.disabled).toBeUndefined();
  });

  it("retires the split buttons once it is resolved, leaving one Reject on the card", () => {
    const ids = buttons(split({ final: { outcome: "yes", by: "d1", at: "x" } })).map(
      (b) => b.custom_id,
    );
    expect(ids).not.toContain("app|final-yes|12");
    expect(ids).not.toContain("app|final-no|12");
    expect(ids.filter((id) => id === "app|outcome-reject|12")).toHaveLength(1);
  });

  it("unlocks the outcome buttons once a final is recorded", () => {
    const ids = buttons(split({ final: { outcome: "yes", by: "d1", at: "x" } })).map(
      (b) => b.custom_id,
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        "app|outcome-welcome|12",
        "app|outcome-reject|12",
        "app|outcome-waitlist|12",
      ]),
    );
  });

  it("offers no outcome while the split is unresolved", () => {
    const ids = buttons(split()).map((b) => b.custom_id ?? "");
    expect(ids.some((id) => id.startsWith("app|outcome-"))).toBe(false);
  });

  it("offers no outcome while still in review", () => {
    const msg = buildIntakeMessage(
      makeRow(),
      opts({ state: "open", decision: emptyDecision(), directorIds: ["d1"], minVotes: 2 }),
    );
    const ids = buttons(msg).map((b) => b.custom_id ?? "");
    expect(ids.some((id) => id.startsWith("app|outcome-"))).toBe(false);
  });
});

describe("outcome buttons", () => {
  const decided = (
    ballots: Record<string, Ballot>,
    over: Partial<CardOptions> = {},
  ) =>
    buildIntakeMessage(
      makeRow(),
      opts({
        state: "open",
        decision: { ...emptyDecision(), ballots },
        directorIds: Object.keys(ballots),
        minVotes: 1,
        ...over,
      }),
    );

  const ids = (msg: MessagePayload): string[] =>
    (msg.components as { components: { custom_id?: string }[] }[])
      .flatMap((row) => row.components)
      .map((b) => b.custom_id ?? "");

  it("offers all three once the vote is a unanimous yes", () => {
    expect(ids(decided({ d1: ["Hearts"] }))).toEqual(
      expect.arrayContaining([
        "app|outcome-welcome|12",
        "app|outcome-reject|12",
        "app|outcome-waitlist|12",
      ]),
    );
  });

  it("never puts a welcome button under a unanimous no", () => {
    const after = ids(decided({ d1: [] }));
    expect(after).not.toContain("app|outcome-welcome|12");
    expect(after).toEqual(
      expect.arrayContaining(["app|outcome-reject|12", "app|outcome-waitlist|12"]),
    );
  });

  it("keeps all three visible after one is chosen, so a misclick is correctable", () => {
    const after = ids(
      decided({ d1: [] }, { outcome: { outcome: "waitlisted", by: "d1", at: "x" } }),
    );
    expect(after).toEqual(
      expect.arrayContaining([
        "app|outcome-welcome|12",
        "app|outcome-reject|12",
        "app|outcome-waitlist|12",
      ]),
    );
  });

  it("says on the card that the email is drafted but not sent", () => {
    const msg = decided({ d1: ["Hearts"] }, { outcome: { outcome: "welcomed", by: "d1", at: "x" } });
    expect(firstEmbedDescription(msg)).toContain("not sent yet");
  });

  it("says it was sent once the draft is published", () => {
    const msg = decided(
      { d1: ["Hearts"] },
      { outcome: { outcome: "welcomed", by: "d1", at: "x", sentAt: "y" } },
    );
    const desc = firstEmbedDescription(msg);
    expect(desc).toContain("email sent");
    expect(desc).not.toContain("not sent yet");
  });

  it("records the outcome in the footer", () => {
    const msg = decided({ d1: ["Hearts"] }, { outcome: { outcome: "waitlisted", by: "d1", at: "x" } });
    expect(embedJson(msg)).toContain("· waitlisted");
  });
});

describe("interview buttons", () => {
  const interview = (over: Partial<InterviewRecord> = {}): InterviewRecord => ({
    state: "drafted",
    date: "2026-09-20",
    time: "14:30",
    durationMinutes: 30,
    draftedBy: "d1",
    draftedAt: "2026-09-10T00:00:00Z",
    ...over,
  });

  /** Interviews need a unanimous yes behind them, so these cards carry one. */
  const card = (state: CardState, iv?: InterviewRecord, ballots: Record<string, Ballot> = { d1: ["Hearts"] }) =>
    buildIntakeMessage(
      makeRow({
        method:
          state === "open" ? "Existing dance video submission and interview" : "RISK Audition process",
      }),
      opts({
        state,
        decision: { ...emptyDecision(), ballots },
        directorIds: ["d1"],
        minVotes: 1,
        interview: iv,
      }),
    );

  const ids = (msg: MessagePayload): string[] =>
    (msg.components as { components: { custom_id?: string }[] }[] | undefined)
      ?.flatMap((row) => row.components)
      .map((b) => b.custom_id ?? "")
      .filter(Boolean) ?? [];

  const labels = (msg: MessagePayload): string[] =>
    (msg.components as { components: { label?: string }[] }[] | undefined)
      ?.flatMap((row) => row.components)
      .map((b) => b.label ?? "") ?? [];

  it("offers [Interview] once the directors have agreed to interview", () => {
    expect(ids(card("open"))).toContain("app|interview|12");
  });

  it("hides it while a RISK-process applicant hasn't submitted", () => {
    expect(ids(card("awaiting"))).not.toContain("app|interview|12");
  });

  it("hides it while the vote is still undecided", () => {
    expect(ids(card("open", undefined, {}))).not.toContain("app|interview|12");
  });

  it("never offers an interview to someone the directors rejected", () => {
    expect(ids(card("open", undefined, { d1: [] }))).not.toContain("app|interview|12");
  });

  it("stops offering an interview once an outcome is recorded", () => {
    const msg = buildIntakeMessage(
      makeRow(),
      opts({
        state: "open",
        decision: { ...emptyDecision(), ballots: { d1: ["Hearts"] } },
        directorIds: ["d1"],
        minVotes: 1,
        outcome: { outcome: "welcomed", by: "d1", at: "x" },
      }),
    );
    expect(ids(msg)).not.toContain("app|interview|12");
  });

  it("only offers [Interview Confirmed] once an invitation has gone out", () => {
    expect(ids(card("open", interview({ state: "drafted" })))).not.toContain(
      "app|interview-confirm|12",
    );
    expect(ids(card("open", interview({ state: "offered" })))).toContain(
      "app|interview-confirm|12",
    );
  });

  it("relabels the button once something is already drafted", () => {
    expect(labels(card("open", interview()))).toContain("Redraft interview");
    expect(labels(card("open"))).toContain("Interview");
  });

  it("stops offering a new time once it's scheduled", () => {
    const scheduled = ids(card("open", interview({ state: "scheduled" })));
    expect(scheduled).not.toContain("app|interview|12");
    expect(scheduled).not.toContain("app|interview-confirm|12");
  });

  it("shows the interview state in the description and footer", () => {
    const msg = card("open", interview({ state: "offered" }));
    expect(firstEmbedDescription(msg)).toContain("Interview offered");
    expect(embedJson(msg)).toContain("interview-offered");
  });

  it("never exceeds Discord's five action rows", () => {
    const msg = buildIntakeMessage(
      makeRow(),
      opts({
        state: "open",
        decision: {
          ...emptyDecision(),
          ballots: { d1: ["Hearts"], d2: [] },
          final: { outcome: "yes", by: "d1", at: "x" },
        },
        directorIds: ["d1", "d2"],
        minVotes: 2,
        interview: interview({ state: "offered" }),
        sheetUrl: "https://example.com",
      }),
    );
    expect((msg.components as unknown[]).length).toBeLessThanOrEqual(5);
  });
});

describe("placement select", () => {
  const pendingCard = (outcome: "welcomed" | "rejected" | "waitlisted", appliedFor: string) =>
    buildIntakeMessage(
      makeRow({ fields: { I: appliedFor } }),
      opts({
        state: "open",
        decision: { ...emptyDecision(), ballots: { d1: ["Hearts"] } },
        directorIds: ["d1"],
        minVotes: 1,
        pending: { outcome, startedBy: "d1" },
      }),
    );

  /** By custom_id, not by type — the ballot is a select too. */
  const select = (msg: MessagePayload) =>
    (
      msg.components as {
        components: { custom_id?: string; options?: { value: string }[] }[];
      }[]
    )
      .flatMap((row) => row.components)
      .find((c) => c.custom_id === "app|placement|12");

  it("offers only the subunits they auditioned for", () => {
    const options = select(pendingCard("welcomed", "Hearts, Clubs"))?.options;
    expect(options?.map((o) => o.value)).toEqual(["Hearts", "Clubs"]);
  });

  it("falls back to all three rather than blocking on an odd answer", () => {
    const options = select(pendingCard("welcomed", "whichever you think"))?.options;
    expect(options?.map((o) => o.value)).toEqual(["Spades", "Hearts", "Clubs"]);
  });

  it("appears for a waitlist too, since that records an offer", () => {
    expect(select(pendingCard("waitlisted", "Spades"))).toBeDefined();
  });

  it("never appears for a rejection, which has no placement", () => {
    expect(select(pendingCard("rejected", "Spades"))).toBeUndefined();
  });

  it("says on the card what it's waiting for", () => {
    expect(firstEmbedDescription(pendingCard("welcomed", "Hearts"))).toContain(
      "Waiting on placement",
    );
  });

  it("isn't there when no decision is in flight", () => {
    const msg = buildIntakeMessage(
      makeRow({ fields: { I: "Hearts" } }),
      opts({ state: "open", decision: emptyDecision(), directorIds: ["d1"], minVotes: 1 }),
    );
    expect(select(msg)).toBeUndefined();
  });
});

describe("resolving a split", () => {
  const split = () =>
    buildIntakeMessage(
      makeRow(),
      opts({
        state: "open",
        decision: { ...emptyDecision(), ballots: { d1: ["Hearts"], d2: [] } },
        directorIds: ["d1", "d2"],
        minVotes: 2,
      }),
    );

  const labelsOf = (msg: MessagePayload): string[] =>
    (msg.components as { components: { label?: string }[] }[])
      .flatMap((r) => r.components)
      .map((b) => b.label ?? "");

  it("names the buttons by what happens next, not by which way the vote went", () => {
    expect(labelsOf(split())).toEqual(
      expect.arrayContaining(["Move onto Interview", "Reject from RISK"]),
    );
    expect(labelsOf(split())).not.toContain("Final Yes");
  });

  it("offers no outcome buttons until the split is settled", () => {
    const ids = (split().components as { components: { custom_id?: string }[] }[])
      .flatMap((r) => r.components)
      .map((b) => b.custom_id ?? "");
    expect(ids.some((id) => id.startsWith("app|outcome-"))).toBe(false);
  });
});

describe("the ballot", () => {
  const ballotCard = (appliedFor: string, decision = emptyDecision()) =>
    buildIntakeMessage(
      makeRow({ fields: { I: appliedFor } }),
      opts({ state: "open", decision, directorIds: ["d1", "d2"], minVotes: 2 }),
    );

  const ballot = (msg: MessagePayload) =>
    (
      msg.components as {
        components: {
          custom_id?: string;
          disabled?: boolean;
          options?: { value: string; label: string }[];
        }[];
      }[]
    )
      .flatMap((r) => r.components)
      .find((c) => c.custom_id === "app|vote|12");

  it("offers the subunits they auditioned for, plus an explicit none", () => {
    const options = ballot(ballotCard("Hearts, Clubs"))?.options;
    expect(options?.map((o) => o.value)).toEqual(["Hearts", "Clubs", "__none__"]);
  });

  it("lets one director pick more than one subunit", () => {
    const select = ballot(ballotCard("Spades, Hearts, Clubs")) as { max_values: number };
    expect(select.max_values).toBe(4);
  });

  it("locks once the ballots disagree", () => {
    const split = { ...emptyDecision(), ballots: { d1: ["Hearts"], d2: [] } };
    expect(ballot(ballotCard("Hearts", split))?.disabled).toBe(true);
  });

  it("stays open while everyone still agrees", () => {
    const agreeing = { ...emptyDecision(), ballots: { d1: ["Hearts"] } };
    expect(ballot(ballotCard("Hearts", agreeing))?.disabled).toBe(false);
  });

  it("is replaced by the placement select while an outcome is being made", () => {
    const msg = buildIntakeMessage(
      makeRow({ fields: { I: "Hearts" } }),
      opts({
        state: "open",
        decision: { ...emptyDecision(), ballots: { d1: ["Hearts"] } },
        directorIds: ["d1"],
        minVotes: 1,
        pending: { outcome: "welcomed", startedBy: "d1" },
      }),
    );
    expect(ballot(msg)).toBeUndefined();
    expect(JSON.stringify(msg.components)).toContain("app|placement|12");
  });
});

describe("placement pre-selection", () => {
  const seeded = (subunits?: string[]) =>
    buildIntakeMessage(
      makeRow({ fields: { I: "Spades, Hearts, Clubs" } }),
      opts({
        state: "open",
        decision: { ...emptyDecision(), ballots: { d1: ["Hearts"] } },
        directorIds: ["d1"],
        minVotes: 1,
        pending: { outcome: "welcomed", startedBy: "d1", ...(subunits ? { subunits } : {}) },
      }),
    );

  const chosen = (msg: MessagePayload): string[] =>
    (
      msg.components as {
        components: { custom_id?: string; options?: { value: string; default?: boolean }[] }[];
      }[]
    )
      .flatMap((r) => r.components)
      .find((c) => c.custom_id === "app|placement|12")
      ?.options?.filter((o) => o.default)
      .map((o) => o.value) ?? [];

  it("pre-selects what the vote agreed on", () => {
    expect(chosen(seeded(["Hearts"]))).toEqual(["Hearts"]);
  });

  it("pre-selects a multi-subunit placement in full", () => {
    expect(chosen(seeded(["Hearts", "Clubs"]))).toEqual(["Hearts", "Clubs"]);
  });

  it("selects nothing after a split, where nothing was agreed", () => {
    expect(chosen(seeded())).toEqual([]);
  });
});
