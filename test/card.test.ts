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
import { emptyDecision, type Decision } from "../src/applications/decision";
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

  it("gives a videographer one line and no buttons", () => {
    const msg = buildIntakeMessage(makeRow({ type: "Videographer / editor" }), opts());
    expect(msg.content).toContain("Mimi");
    expect(msg.embeds).toBeUndefined();
    expect(msg.components).toBeUndefined();
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
    expect(ids).not.toContain("app|yes|12");
    expect(ids).toContain("app|open|12");
  });

  it("says voting opens once the audition arrives", () => {
    expect(firstEmbedDescription(withDecision("awaiting"))).toContain("Voting opens once it arrives");
  });

  it("shows them as soon as a RISK-process audition is submitted", () => {
    const ids = buttonIds(withDecision("submitted"));
    expect(ids).toEqual(expect.arrayContaining(["app|yes|12", "app|no|12", "app|hold|12"]));
  });

  it("shows them immediately for an existing-links applicant", () => {
    const ids = buttonIds(withDecision("open"));
    expect(ids).toEqual(expect.arrayContaining(["app|yes|12", "app|feedback|12"]));
  });

  it("hides them on a closed card", () => {
    const ids = buttonIds(withDecision("closed"));
    expect(ids).not.toContain("app|yes|12");
    expect(ids).toContain("app|reopen|12");
  });
});

describe("split votes on the card", () => {
  const split = (over: Partial<Decision> = {}) =>
    buildIntakeMessage(
      makeRow(),
      opts({
        state: "open",
        decision: { ...emptyDecision(), ballots: { d1: "yes", d2: "no" }, ...over },
        directorIds: ["d1", "d2"],
        minVotes: 2,
      }),
    );

  const buttons = (msg: MessagePayload) =>
    (msg.components as { components: { custom_id?: string; disabled?: boolean }[] }[])
      .flatMap((row) => row.components);

  it("locks the vote buttons and offers a recorded outcome instead", () => {
    const all = buttons(split());
    const vote = all.find((b) => b.custom_id === "app|yes|12");
    expect(vote?.disabled).toBe(true);
    expect(all.map((b) => b.custom_id)).toEqual(
      expect.arrayContaining(["app|final-yes|12", "app|final-no|12"]),
    );
  });

  it("leaves feedback available during the discussion", () => {
    const feedback = buttons(split()).find((b) => b.custom_id === "app|feedback|12");
    expect(feedback?.disabled).toBeUndefined();
  });

  it("keeps both final buttons after one is pressed, so a misclick is correctable", () => {
    const ids = buttons(split({ final: { outcome: "yes", by: "d1", at: "x" } })).map(
      (b) => b.custom_id,
    );
    expect(ids).toEqual(expect.arrayContaining(["app|final-yes|12", "app|final-no|12"]));
  });

  it("offers a locked send button once settled, since email is rank 27", () => {
    const send = buttons(split({ final: { outcome: "yes", by: "d1", at: "x" } })).find((b) =>
      b.custom_id?.startsWith("app|send-"),
    );
    expect(send?.disabled).toBe(true);
  });

  it("has no send button while still in review", () => {
    const msg = buildIntakeMessage(
      makeRow(),
      opts({ state: "open", decision: emptyDecision(), directorIds: ["d1"], minVotes: 2 }),
    );
    const ids = buttons(msg).map((b) => b.custom_id ?? "");
    expect(ids.some((id) => id.startsWith("app|send-"))).toBe(false);
  });
});
