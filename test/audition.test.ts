import { describe, expect, it } from "vitest";
import {
  AUDITION_TARGETS,
  auditionState,
  isAuditionTarget,
  deadline,
  dueDateFrom,
  extensionPending,
  hasLapsed,
  isProposalClosed,
  isUnresolved,
  lapsesAt,
  MAX_EXTENSION_DAYS,
  needsReminder,
  type AuditionRecord,
} from "../src/trainees/audition";
import { isCoach } from "../src/config/directors";
import { renderProposalCard } from "../src/trainees/auditionCard";

const audition = (over: Partial<AuditionRecord> = {}): AuditionRecord => ({
  auditionId: "a1b2c3",
  discordId: "t1",
  proposedOn: "2026-09-01T00:00:00.000Z",
  targetSubunit: "Hearts",
  song: "Killin' It",
  songLink: "https://youtu.be/abc",
  timestamp: "1:12",
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

describe("auditionState", () => {
  it("starts at proposed", () => {
    expect(auditionState(audition())).toBe("proposed");
  });

  it("moves to approved once the coach says yes", () => {
    expect(auditionState(approved())).toBe("approved");
  });

  it("moves to submitted when the video lands", () => {
    expect(
      auditionState(approved({ submittedOn: "2026-09-05T00:00:00.000Z" })),
    ).toBe("submitted");
  });

  it("reports the result once there is one", () => {
    expect(auditionState(approved({ result: "pass" }))).toBe("passed");
    expect(auditionState(approved({ result: "fail" }))).toBe("failed");
  });

  it("distinguishes another-song from declined", () => {
    expect(auditionState(audition({ proposalStatus: "another-song" }))).toBe("another-song");
    expect(auditionState(audition({ proposalStatus: "declined" }))).toBe("declined");
  });

  /**
   * A result recorded after a lapse wins. Late auditions are explicitly allowed
   * to resolve, and /audition reopen exists precisely so a lapse isn't final.
   */
  it("lets a late result override a lapse", () => {
    const late = approved({ lapsedOn: "2026-09-11T00:00:00.000Z", result: "pass" });
    expect(auditionState(late)).toBe("passed");
  });
});

describe("isUnresolved", () => {
  it("blocks a new proposal while one is outstanding", () => {
    expect(isUnresolved(audition())).toBe(true);
    expect(isUnresolved(approved())).toBe(true);
    expect(isUnresolved(approved({ submittedOn: "2026-09-05T00:00:00.000Z" }))).toBe(true);
  });

  /** The one case that must not block: it exists to send them back to propose. */
  it("does not block after the coach asks for another song", () => {
    expect(isUnresolved(audition({ proposalStatus: "another-song" }))).toBe(false);
  });

  it("does not block once it ended", () => {
    expect(isUnresolved(audition({ proposalStatus: "declined" }))).toBe(false);
    expect(isUnresolved(approved({ lapsedOn: "x" }))).toBe(false);
    expect(isUnresolved(approved({ result: "fail" }))).toBe(false);
  });
});

describe("deadlines", () => {
  it("is approved_on plus audition_days", () => {
    expect(dueDateFrom("2026-09-01T00:00:00.000Z", 7)).toBe("2026-09-08T00:00:00.000Z");
  });

  it("lets an extension supersede the original due date", () => {
    const extended = approved({ extendedTo: "2026-09-13T00:00:00.000Z" });
    expect(deadline(extended)).toBe("2026-09-13T00:00:00.000Z");
  });

  /**
   * The grace period has to stay shorter than an extension, or ignoring the
   * deadline beats asking for more time. 3 against 5, per config.
   */
  it("lapses three days after the deadline, not five", () => {
    expect(lapsesAt(approved(), 3)).toBe("2026-09-11T00:00:00.000Z");
  });

  it("counts the lapse from the extension when there is one", () => {
    const extended = approved({ extendedTo: "2026-09-13T00:00:00.000Z" });
    expect(lapsesAt(extended, 3)).toBe("2026-09-16T00:00:00.000Z");
  });
});

describe("hasLapsed", () => {
  it("is false before the grace period is up", () => {
    expect(hasLapsed(approved(), 3, new Date("2026-09-10T00:00:00.000Z"))).toBe(false);
  });

  it("is true once it passes", () => {
    expect(hasLapsed(approved(), 3, new Date("2026-09-11T00:00:01.000Z"))).toBe(true);
  });

  it("never lapses something already submitted", () => {
    const submitted = approved({ submittedOn: "2026-09-05T00:00:00.000Z" });
    expect(hasLapsed(submitted, 3, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("never lapses a proposal the coach hasn't approved", () => {
    expect(hasLapsed(audition(), 3, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("needsReminder", () => {
  it("fires inside the last day", () => {
    expect(needsReminder(approved(), new Date("2026-09-07T06:00:00.000Z"))).toBe(true);
  });

  it("stays quiet earlier than that", () => {
    expect(needsReminder(approved(), new Date("2026-09-05T00:00:00.000Z"))).toBe(false);
  });

  it("fires once", () => {
    const reminded = approved({ remindedOn: "2026-09-07T06:00:00.000Z" });
    expect(needsReminder(reminded, new Date("2026-09-07T12:00:00.000Z"))).toBe(false);
  });

  it("doesn't chase someone who already submitted", () => {
    const submitted = approved({ submittedOn: "2026-09-05T00:00:00.000Z" });
    expect(needsReminder(submitted, new Date("2026-09-07T06:00:00.000Z"))).toBe(false);
  });

  it("follows the extension once granted", () => {
    const extended = approved({ extendedTo: "2026-09-13T00:00:00.000Z" });
    expect(needsReminder(extended, new Date("2026-09-07T06:00:00.000Z"))).toBe(false);
    expect(needsReminder(extended, new Date("2026-09-12T06:00:00.000Z"))).toBe(true);
  });
});

describe("extensionPending", () => {
  it("is true only while the coach hasn't answered", () => {
    const asked = approved({ extension: { reason: "midterms", days: 4, at: "x" } });
    expect(extensionPending(asked)).toBe(true);

    const answered = approved({
      extension: { reason: "midterms", days: 4, at: "x", granted: true, by: "c1", answeredAt: "y" },
    });
    expect(extensionPending(answered)).toBe(false);
  });

  it("is false when nobody asked", () => {
    expect(extensionPending(approved())).toBe(false);
  });
});

describe("who counts as a coach", () => {
  /**
   * Directors are an enumerated list because "all directors have voted" needs a
   * denominator. Coaches never do — the only question is whether the clicker is
   * one — and the answer rides along in the interaction, so no list and no
   * GUILD_MEMBERS intent.
   */
  it("reads the role off the member who clicked", () => {
    expect(isCoach(["r-coach", "r-other"], "r-coach", [], "u1")).toBe(true);
    expect(isCoach(["r-other"], "r-coach", [], "u1")).toBe(false);
  });

  it("lets a director act without holding the coach role", () => {
    expect(isCoach(["r-other"], "r-coach", ["u1"], "u1")).toBe(true);
  });

  it("refuses everyone when no coach role is configured", () => {
    expect(isCoach(["r-coach"], null, [], "u1")).toBe(false);
  });

  it("survives an interaction that carries no roles at all", () => {
    expect(isCoach(undefined, "r-coach", [], "u1")).toBe(false);
    expect(isCoach(undefined, "r-coach", ["u1"], "u1")).toBe(true);
  });
});

describe("extension requests", () => {
  it("carries the number of days the trainee asked for", () => {
    const asked = approved({ extension: { reason: "midterms", days: 4, at: "x" } });
    expect(asked.extension?.days).toBe(4);
    expect(extensionPending(asked)).toBe(true);
  });

  /**
   * A denial is a rejection like any other, so it owes a reason — "no" without
   * one just invites asking again.
   */
  it("keeps the coach's reason on a denial", () => {
    const denied = approved({
      extension: {
        reason: "midterms",
        days: 4,
        at: "x",
        granted: false,
        by: "c1",
        answeredAt: "y",
        note: "The showcase date can't move.",
      },
    });
    expect(extensionPending(denied)).toBe(false);
    expect(denied.extension?.note).toBe("The showcase date can't move.");
  });

  it("caps what can be asked for, so a request stays a form and not a negotiation", () => {
    expect(MAX_EXTENSION_DAYS).toBe(30);
  });
});

describe("isProposalClosed", () => {
  it("is true for every way a proposal ends", () => {
    expect(isProposalClosed(audition({ proposalStatus: "another-song" }))).toBe(true);
    expect(isProposalClosed(audition({ proposalStatus: "declined" }))).toBe(true);
    expect(isProposalClosed(approved({ lapsedOn: "x" }))).toBe(true);
    expect(isProposalClosed(approved({ result: "pass" }))).toBe(true);
    expect(isProposalClosed(approved({ result: "fail" }))).toBe(true);
  });

  /**
   * The three states that still owe someone something. Archiving any of these
   * would hide the proposals that are the entire reason to look at the channel.
   */
  it("is false while anyone is still waiting", () => {
    expect(isProposalClosed(audition())).toBe(false);
    expect(isProposalClosed(approved())).toBe(false);
    expect(isProposalClosed(approved({ submittedOn: "2026-09-05T00:00:00.000Z" }))).toBe(false);
  });

  it("agrees with the card, which collapses exactly these", () => {
    const closed = audition({ proposalStatus: "declined" });
    expect(isProposalClosed(closed)).toBe(true);
    expect((renderProposalCard(closed).content as string).startsWith("-# ")).toBe(true);
  });
});

describe("what they're auditioning for", () => {
  it("accepts the two subunits a trainee can audition into", () => {
    expect(AUDITION_TARGETS).toEqual(["Hearts", "Spades"]);
    expect(isAuditionTarget("Hearts")).toBe(true);
    expect(isAuditionTarget("Spades")).toBe(true);
  });

  /** Clubs is the trainee unit they're already in — there's nothing to audition for. */
  it("rejects Clubs, and anything else", () => {
    expect(isAuditionTarget("Clubs")).toBe(false);
    expect(isAuditionTarget("Diamonds")).toBe(false);
    expect(isAuditionTarget("hearts")).toBe(false);
    expect(isAuditionTarget("")).toBe(false);
  });
});

describe("closing the proposal out", () => {
  const submitted = (over: Partial<AuditionRecord> = {}) =>
    approved({ submittedOn: "2026-09-05T00:00:00.000Z", ...over });

  /**
   * A rejection and an expiry both end the proposal, not just the audition —
   * the card collapses and commit() archives the thread off the same predicate.
   */
  it("closes when they don't pass", () => {
    const failed = submitted({ result: "fail", resultSentAt: "2026-09-06T00:00:00.000Z" });
    expect(isProposalClosed(failed)).toBe(true);
    const card = renderProposalCard(failed);
    expect((card.content as string).startsWith("-# ")).toBe(true);
    expect(card.components).toEqual([]);
  });

  it("closes when their time expires", () => {
    const lapsed = approved({ lapsedOn: "2026-09-11T00:00:00.000Z" });
    expect(isProposalClosed(lapsed)).toBe(true);
    const card = renderProposalCard(lapsed);
    expect((card.content as string).startsWith("-# ")).toBe(true);
    expect(card.components).toEqual([]);
  });

  /** Open, but with nothing to press — the coach already answered this part. */
  it("stays open while the audition is still being reviewed", () => {
    expect(isProposalClosed(submitted())).toBe(false);
    const card = renderProposalCard(submitted());
    expect((card.content as string).startsWith("-# ")).toBe(false);
    expect(card.content as string).toContain("being reviewed");
  });

  it("frees them to propose again once it's closed", () => {
    expect(isUnresolved(submitted({ result: "fail", resultSentAt: "w" }))).toBe(false);
    expect(isUnresolved(approved({ lapsedOn: "w" }))).toBe(false);
  });
});
