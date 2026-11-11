import { describe, expect, it } from "vitest";
import {
  auditionCustomId,
  parseAuditionCustomId,
  renderProposalCard,
  renderReviewCard,
} from "../src/trainees/auditionCard";
import type { AuditionRecord } from "../src/trainees/audition";
import type { MessagePayload } from "../src/discord/types";

const audition = (over: Partial<AuditionRecord> = {}): AuditionRecord => ({
  auditionId: "a1b2c3d4e5f6",
  discordId: "t1",
  proposedOn: "2026-09-01T00:00:00.000Z",
  targetSubunit: "Hearts",
  song: "Killin' It",
  songLink: "https://youtu.be/abc",
  timestamp: "1:12-1:45",
  proposalStatus: "proposed",
  ...over,
});

const approved = (over: Partial<AuditionRecord> = {}) =>
  audition({
    proposalStatus: "approved",
    approvedOn: "2026-09-01T00:00:00.000Z",
    dueOn: "2026-09-08T00:00:00.000Z",
    ...over,
  });

const ids = (msg: { components?: unknown }): string[] =>
  ((msg.components ?? []) as { components: { custom_id?: string }[] }[])
    .flatMap((row) => row.components)
    .map((c) => c.custom_id ?? "")
    .filter(Boolean);

const labels = (msg: { components?: unknown }): string[] =>
  ((msg.components ?? []) as { components: { label?: string }[] }[])
    .flatMap((row) => row.components)
    .map((c) => c.label ?? "")
    .filter(Boolean);

describe("audition custom ids", () => {
  it("round-trips inside Discord's 100-char cap", () => {
    const id = auditionCustomId("approve", "a1b2c3d4e5f6");
    expect(parseAuditionCustomId(id)).toEqual({
      action: "approve",
      auditionId: "a1b2c3d4e5f6",
    });
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it("ignores ids belonging to other features", () => {
    expect(parseAuditionCustomId("app|vote|12")).toBeNull();
    expect(parseAuditionCustomId("draft|approve|abcdef")).toBeNull();
    expect(parseAuditionCustomId("aud|approve|NOT-HEX")).toBeNull();
    expect(parseAuditionCustomId("aud|approve")).toBeNull();
  });

  /** A trainee has several attempts; a stale button must not act on the live one. */
  it("carries the audition, not the trainee", () => {
    const first = auditionCustomId("approve", "aaaaaa");
    const second = auditionCustomId("approve", "bbbbbb");
    expect(first).not.toBe(second);
  });
});

describe("the coach's proposal card", () => {
  it("asks the three questions the doc asks", () => {
    expect(labels(renderProposalCard(audition()))).toEqual([
      "Approve",
      "Ask for another song",
      "Decline this cycle",
    ]);
  });

  it("shows the song, where in it, and the link", () => {
    const content = renderProposalCard(audition()).content as string;
    expect(content).toContain("Killin' It");
    expect(content).toContain("1:12-1:45");
    expect(content).toContain("https://youtu.be/abc");
  });

  it("drops the buttons once it's been answered", () => {
    expect(ids(renderProposalCard(approved()))).toEqual([]);
  });

  it("still names the song on a collapsed card, so the thread reads as history", () => {
    const content = renderProposalCard(audition({ proposalStatus: "declined" }))
      .content as string;
    expect(content).toContain("Killin' It");
  });

  /**
   * Asking for another song rejects the proposal, not an audition — nothing has
   * been performed yet, so nothing may read as a failed audition.
   */
  it("is clear that the proposal closed, not an audition", () => {
    const content = renderProposalCard(
      audition({ proposalStatus: "another-song" }),
    ).content as string;
    expect(content).toContain("Another song asked for");
    expect(content).not.toContain("attempt");
    expect(content).not.toContain("Did not pass");
  });

  /**
   * The extension is the only thing on the card with someone waiting, so it
   * takes the card over — leaving [Approve] beside it invites answering a
   * question nobody asked.
   */
  it("replaces everything with the extension question when one is pending", () => {
    const asking = approved({ extension: { reason: "midterms", days: 4, at: "x" } });
    expect(labels(renderProposalCard(asking))).toEqual(["Grant 4 days", "Deny"]);
    expect(renderProposalCard(asking).content as string).toContain("midterms");
    // The button says what granting it would cost, so a coach doesn't have to
    // read the line above to know what they're agreeing to.
    expect(renderProposalCard(asking).content as string).toContain("4 more days requested");
  });

  it("goes back to no buttons once the extension is answered", () => {
    const answered = approved({
      extension: { reason: "midterms", days: 4, at: "x", granted: true, by: "c1", answeredAt: "y" },
      extendedTo: "2026-09-13T00:00:00.000Z",
    });
    expect(ids(renderProposalCard(answered))).toEqual([]);
    expect(renderProposalCard(answered).content as string).toContain("extended");
  });

  it("keeps the coach's reason on the collapsed line", () => {
    const content = renderProposalCard(
      audition({
        proposalStatus: "another-song",
        proposalNote: "Too slow for the panel — try something with a harder beat.",
        decidedBy: "c1",
      }),
    ).content as string;
    expect(content).toContain("harder beat");
  });

  /**
   * A finished proposal collapses to one muted line. It still belongs in the
   * trainee's thread as the record of what was said, but at full size it
   * competes with the proposal that actually needs answering.
   */
  describe("once it's finished with", () => {
    const closedStates = [
      ["another-song", "Another song asked for"],
      ["declined", "Declined this cycle"],
    ] as const;

    for (const [status, label] of closedStates) {
      it(`collapses a ${status} proposal to a grey line`, () => {
        const msg = renderProposalCard(audition({ proposalStatus: status }));
        const content = msg.content as string;
        expect(content.startsWith("-# ")).toBe(true);
        expect(content).toContain(label);
        expect(content.split("\n").length).toBeLessThanOrEqual(2);
        expect(msg.components).toEqual([]);
      });
    }

    it("collapses a lapsed proposal too", () => {
      const content = renderProposalCard(approved({ lapsedOn: "2026-09-11T00:00:00.000Z" }))
        .content as string;
      expect(content).toContain("Lapsed");
      expect(content.startsWith("-# ")).toBe(true);
    });

    it("collapses once the audition has a result, since the review card has it", () => {
      const content = renderProposalCard(
        approved({ submittedOn: "2026-09-05T00:00:00.000Z", result: "pass" }),
      ).content as string;
      expect(content).toContain("Passed");
      expect(content.startsWith("-# ")).toBe(true);
    });

    it("leaves a live proposal at full size", () => {
      const content = renderProposalCard(audition()).content as string;
      expect(content.startsWith("-# ")).toBe(false);
      expect(content).toContain("waiting on a coach");
    });

    it("leaves an approved one at full size, since its deadline still matters", () => {
      const content = renderProposalCard(approved()).content as string;
      expect(content.startsWith("-# ")).toBe(false);
      expect(content).toContain("Due");
    });
  });

  it("keeps the save actions addressable, so the modal can come back", () => {
    expect(parseAuditionCustomId("aud|another-song-save|a1b2c3d4e5f6")).toEqual({
      action: "another-song-save",
      auditionId: "a1b2c3d4e5f6",
    });
    expect(parseAuditionCustomId("aud|decline-save|a1b2c3d4e5f6")).toEqual({
      action: "decline-save",
      auditionId: "a1b2c3d4e5f6",
    });
  });

  /** A YouTube unfurl under every proposal would bury the buttons. */
  it("suppresses the link preview", () => {
    expect(renderProposalCard(audition()).flags).toBe(4);
  });
});

describe("the submitted audition card", () => {
  const OPTS = { directorIds: ["d1", "d2", "d3"], minVotes: 2 };

  const submitted = (over: Partial<AuditionRecord> = {}) =>
    approved({
      displayName: "Mimi",
      submittedOn: "2026-09-05T00:00:00.000Z",
      submissionUrl: "https://youtu.be/mine",
      ...over,
    });

  const card = (over: Partial<AuditionRecord> = {}) => renderReviewCard(submitted(over), OPTS);

  const description = (msg: MessagePayload): string => {
    const embed = (msg.embeds as { description?: string }[] | undefined)?.[0];
    if (!embed?.description) throw new Error("no embed description");
    return embed.description;
  };

  const voted = (ballots: Record<string, string[]>): Partial<AuditionRecord> => ({
    decision: { ballots, feedback: {} },
  });

  /**
   * SUPPRESS_EMBEDS on a card that *is* an embed hides the card. It belongs on
   * the plain-text proposal card and nowhere near this one.
   */
  it("does not suppress its own embed", () => {
    expect(card().flags).toBe(0);
    expect((card().embeds as unknown[]).length).toBe(1);
  });

  const fieldNamed = (msg: MessagePayload, name: string): string | undefined =>
    (msg.embeds as { fields?: { name: string; value: string }[] }[])[0]?.fields?.find(
      (f) => f.name === name,
    )?.value;

  /** Everything a reviewer needs, each in a labelled place. */
  it("reads like an applicant card — name, subunit, song, both links", () => {
    const msg = card();
    expect((msg.embeds as { title?: string }[])[0]?.title).toBe("Mimi");
    expect(fieldNamed(msg, "Auditioning for")).toBe("Hearts");
    expect(fieldNamed(msg, "Song")).toBe("Killin' It");
    expect(fieldNamed(msg, "From")).toBe("1:12-1:45");
    expect(fieldNamed(msg, "Song reference")).toBe("https://youtu.be/abc");
    expect(fieldNamed(msg, "Audition video")).toBe("https://youtu.be/mine");
  });

  it("says so rather than going blank when the timestamp was left off", () => {
    const msg = renderReviewCard(submitted({ timestamp: "  " }), OPTS);
    expect(fieldNamed(msg, "From")).toBe("—");
  });

  /**
   * They auditioned for one subunit, so the only question is whether that's a
   * pass — never where to put them.
   */
  it("asks pass or not, naming the subunit they auditioned for", () => {
    expect(labels(card())).toEqual(["Pass — Hearts", "Did not pass", "Leave feedback"]);
  });

  it("names the subunit being judged on the button too", () => {
    expect(labels(card())).toContain("Pass — Hearts");
  });

  /** Two agreeing directors settle it; the third may be their coach. */
  it("settles on two votes and offers to send the result", () => {
    const msg = card(voted({ d1: ["Hearts"], d2: ["Hearts"] }));
    expect(description(msg)).toContain("Passed — Hearts");
    expect(ids(msg)).toContain("aud|send-result|a1b2c3d4e5f6");
    expect(labels(msg)).toContain("Review & send — Hearts");
  });

  it("locks the ballot and asks for a decision when they disagree", () => {
    const msg = card(voted({ d1: ["Hearts"], d2: [] }));
    expect(description(msg)).toContain("Discussing");
    expect(ids(msg)).toContain("aud|final-pass|a1b2c3d4e5f6");
    expect(ids(msg)).toContain("aud|final-no|a1b2c3d4e5f6");
    // The ballot buttons go away — the answer is a decision now, not a vote.
    expect(ids(msg)).not.toContain("aud|vote-pass|a1b2c3d4e5f6");
  });

  it("keeps the ballot sealed until enough are in", () => {
    expect(description(card(voted({ d1: ["Hearts"] })))).toContain("1 of 2 needed");
  });

  /**
   * Nothing reaches the trainee without a press, and that press opens the
   * message for a read-through rather than sending it.
   */
  it("never sends on its own — the result is always reviewed first", () => {
    const settled = card(voted({ d1: [], d2: [] }));
    expect(description(settled)).toContain("Did not pass");
    expect(labels(settled)).toContain("Review & send result");
  });

  it("goes quiet once the result has gone out", () => {
    const done = card({
      ...voted({ d1: ["Hearts"], d2: ["Hearts"] }),
      resultSentAt: "2026-09-06T00:00:00.000Z",
      subunits: ["Hearts"],
      result: "pass",
    });
    expect(ids(done)).toEqual([]);
    expect(description(done)).toContain("Result sent");
    expect(description(done)).toContain("Placed in Hearts");
  });

  it("carries no interview row and nothing that sends email", () => {
    const all = JSON.stringify(card(voted({ d1: ["Hearts"], d2: ["Hearts"] })));
    expect(all).not.toContain("interview");
    expect(all.toLowerCase()).not.toContain("email");
  });
});
