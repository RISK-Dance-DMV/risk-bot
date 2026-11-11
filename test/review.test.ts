import { describe, expect, it } from "vitest";
import { emptyDecision, type Ballot, type Decision } from "../src/applications/decision";
import {
  composeFeedback,
  enoughVotes,
  feedbackRevealed,
  isReviewSettled,
  renderReview,
  reviewFeedbackFields,
  reviewPlacement,
  reviewStatus,
  resultMessage,
} from "../src/trainees/review";

const DIRECTORS = ["d1", "d2", "d3"];
const MIN = 2;

const decision = (ballots: Record<string, Ballot>, over: Partial<Decision> = {}): Decision => ({
  ...emptyDecision(),
  ballots,
  ...over,
});

const withFeedback = (ids: string[], base: Decision): Decision => ({
  ...base,
  feedback: Object.fromEntries(
    ids.map((id) => [id, { text: `notes from ${id}`, at: "2026-09-10T00:00:00Z" }]),
  ),
});

describe("reviewStatus", () => {
  it("is new before anyone votes", () => {
    expect(reviewStatus(emptyDecision(), MIN)).toBe("new");
  });

  it("stays in review on a single vote", () => {
    expect(reviewStatus(decision({ d1: ["Hearts"] }), MIN)).toBe("in-review");
  });

  /**
   * The whole point of the trainee threshold: two agreeing directors settle it.
   * The third may be the coach, whose vote is never coming.
   */
  it("settles on two agreeing votes without waiting for the third", () => {
    expect(reviewStatus(decision({ d1: ["Hearts"], d2: ["Hearts"] }), MIN)).toBe("passed");
  });

  it("settles a two-vote no the same way", () => {
    expect(reviewStatus(decision({ d1: [], d2: [] }), MIN)).toBe("failed");
  });

  it("is discussing as soon as two votes differ", () => {
    expect(reviewStatus(decision({ d1: ["Hearts"], d2: ["Spades"] }), MIN)).toBe("discussing");
  });

  it("treats Hearts against Hearts+Spades as a discussion, not a narrower yes", () => {
    expect(
      reviewStatus(decision({ d1: ["Hearts"], d2: ["Hearts", "Spades"] }), MIN),
    ).toBe("discussing");
  });

  it("holds settlement while a [Need to discuss] is outstanding", () => {
    expect(reviewStatus(decision({ d1: ["Hearts"], d2: ["Hearts"], d3: "hold" }), MIN)).toBe(
      "in-review",
    );
  });

  it("lets a recorded outcome override the tally", () => {
    const split = decision(
      { d1: ["Hearts"], d2: ["Spades"] },
      { final: { outcome: "yes", by: "d3", at: "x", subunits: ["Hearts"] } },
    );
    expect(reviewStatus(split, MIN)).toBe("passed");
    expect(reviewPlacement(split, MIN)).toEqual(["Hearts"]);
  });

  it("respects a threshold of all three when that's what's configured", () => {
    expect(reviewStatus(decision({ d1: ["Hearts"], d2: ["Hearts"] }), 3)).toBe("in-review");
  });
});

describe("isReviewSettled", () => {
  it("covers exactly the two terminal statuses", () => {
    expect(isReviewSettled("passed")).toBe(true);
    expect(isReviewSettled("failed")).toBe(true);
    expect(isReviewSettled("discussing")).toBe(false);
    expect(isReviewSettled("in-review")).toBe(false);
    expect(isReviewSettled("new")).toBe(false);
  });
});

describe("sealed ballots and feedback", () => {
  it("hides the tally until enough have voted", () => {
    const text = renderReview(decision({ d1: ["Hearts"] }), DIRECTORS, MIN);
    expect(text).toContain("1 of 2 needed");
    expect(text).not.toContain("<@d1> — Hearts");
  });

  it("reveals who voted what once it settles", () => {
    const text = renderReview(decision({ d1: ["Hearts"], d2: ["Hearts"] }), DIRECTORS, MIN);
    expect(text).toContain("<@d1> — Hearts");
    expect(text).toContain("<@d2> — Hearts");
  });

  /**
   * Tied to the vote settling rather than to everyone having written: a
   * director sitting this one out is never going to write, and holding the
   * others' words hostage to that means the trainee hears nothing.
   */
  it("keeps feedback sealed while the vote is open", () => {
    const open = withFeedback(["d1"], decision({ d1: ["Hearts"] }));
    expect(feedbackRevealed(open, MIN)).toBe(false);
    expect(reviewFeedbackFields(open, DIRECTORS, MIN)).toEqual([]);
    expect(renderReview(open, DIRECTORS, MIN)).toContain("text hidden until the vote settles");
  });

  it("reveals it once the vote settles, even with a director who never wrote", () => {
    const settled = withFeedback(["d1", "d2"], decision({ d1: ["Hearts"], d2: ["Hearts"] }));
    expect(feedbackRevealed(settled, MIN)).toBe(true);
    expect(reviewFeedbackFields(settled, DIRECTORS, MIN)).toHaveLength(2);
  });

  it("names who has written while the text is still sealed", () => {
    const open = withFeedback(["d1"], decision({ d1: ["Hearts"] }));
    expect(renderReview(open, DIRECTORS, MIN)).toContain("(<@d1>)");
  });
});

describe("composeFeedback", () => {
  it("joins the notes in roster order, for the trainee's DM", () => {
    const settled = withFeedback(["d2", "d1"], decision({ d1: ["Hearts"], d2: ["Hearts"] }));
    expect(composeFeedback(settled, DIRECTORS)).toBe("notes from d1\n\nnotes from d2");
  });

  it("skips a director who wrote nothing", () => {
    const settled = withFeedback(["d1"], decision({ d1: ["Hearts"], d2: ["Hearts"] }));
    expect(composeFeedback(settled, DIRECTORS)).toBe("notes from d1");
  });

  it("is empty when nobody wrote", () => {
    expect(composeFeedback(decision({ d1: ["Hearts"] }), DIRECTORS)).toBe("");
  });
});

describe("enoughVotes", () => {
  it("counts cast ballots, not holds", () => {
    expect(enoughVotes(decision({ d1: ["Hearts"], d2: "hold" }), MIN)).toBe(false);
    expect(enoughVotes(decision({ d1: ["Hearts"], d2: [] }), MIN)).toBe(true);
  });
});

describe("resultMessage", () => {
  const settled = decision({ d1: ["Hearts"], d2: ["Hearts"] });

  it("congratulates a pass and names the subunit", () => {
    const text = resultMessage("Hearts", ["Hearts"], "");
    expect(text).toContain("happy to announce");
    expect(text).toContain("welcome to Hearts");
  });

  it("names the subunit they auditioned for on a rejection", () => {
    const text = resultMessage("Spades", [], "");
    expect(text).toContain("your Spades audition didn't pass this time");
    expect(text).toContain("discuss with your coaches");
    expect(text).toContain("You got this!");
  });

  it("carries the feedback under the same line either way", () => {
    expect(resultMessage("Hearts", ["Hearts"], "nice lines")).toContain(
      "Here is the feedback they left you",
    );
    expect(resultMessage("Hearts", [], "watch the timing")).toContain("watch the timing");
  });

  /** The lead-in would dangle into nothing if nobody wrote. */
  it("omits the feedback lead-in when there is none", () => {
    expect(resultMessage("Hearts", [], "   ")).not.toContain("Here is the feedback");
  });

  /**
   * The preview a director approves and the DM that goes out come from this one
   * function. Built separately they would drift, and the preview would be a lie.
   */
  it("is what the preview is built from", () => {
    const feedback = composeFeedback(withFeedback(["d1"], settled), DIRECTORS);
    expect(resultMessage("Hearts", ["Hearts"], feedback)).toContain("notes from d1");
  });
});
