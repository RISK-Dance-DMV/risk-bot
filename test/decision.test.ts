import { describe, expect, it } from "vitest";
import {
  decisionStatus,
  emptyDecision,
  feedbackFields,
  feedbackProgress,
  hasSplit,
  isSettled,
  outcomeTemplateKey,
  renderDecision,
  renderOutcomeLine,
  tally,
  type Ballot,
  type Decision,
} from "../src/applications/decision";

const DIRECTORS = ["d1", "d2", "d3"];

const decision = (
  ballots: Record<string, Ballot>,
  over: Partial<Decision> = {},
): Decision => ({ ...emptyDecision(), ballots, ...over });

describe("tally", () => {
  it("counts a hold separately, because a hold is not a vote", () => {
    const t = tally(decision({ d1: "yes", d2: "no", d3: "hold" }));
    expect(t).toEqual({ yes: 1, no: 1, hold: 1, cast: 2 });
  });
});

describe("hasSplit", () => {
  it("is true only when yes and no are both present", () => {
    expect(hasSplit(decision({ d1: "yes", d2: "no" }))).toBe(true);
    expect(hasSplit(decision({ d1: "yes", d2: "yes" }))).toBe(false);
    expect(hasSplit(decision({ d1: "yes", d2: "hold" }))).toBe(false);
  });
});

describe("decisionStatus", () => {
  it("is new before anyone clicks", () => {
    expect(decisionStatus(emptyDecision(), DIRECTORS, 2)).toBe("new");
  });

  it("is in-review while votes are still coming in", () => {
    expect(decisionStatus(decision({ d1: "yes" }), DIRECTORS, 2)).toBe("in-review");
  });

  it("flips to discussing the moment the vote splits", () => {
    expect(decisionStatus(decision({ d1: "yes", d2: "no" }), DIRECTORS, 2)).toBe("discussing");
  });

  it("splits even before everyone has voted", () => {
    expect(decisionStatus(decision({ d1: "yes", d2: "no" }), [...DIRECTORS, "d4"], 2)).toBe(
      "discussing",
    );
  });

  it("accepts only when every director has voted yes", () => {
    expect(decisionStatus(decision({ d1: "yes", d2: "yes" }), DIRECTORS, 2)).toBe("in-review");
    expect(decisionStatus(decision({ d1: "yes", d2: "yes", d3: "yes" }), DIRECTORS, 2)).toBe(
      "accepted",
    );
  });

  it("rejects on a unanimous no", () => {
    expect(decisionStatus(decision({ d1: "no", d2: "no", d3: "no" }), DIRECTORS, 2)).toBe(
      "rejected",
    );
  });

  it("holds settlement while a [Need to discuss] is outstanding", () => {
    expect(
      decisionStatus(decision({ d1: "yes", d2: "yes", d3: "hold" }), DIRECTORS, 2),
    ).toBe("in-review");
  });

  it("respects the minimum-votes floor", () => {
    expect(decisionStatus(decision({ d1: "yes" }), ["d1"], 2)).toBe("in-review");
    expect(decisionStatus(decision({ d1: "yes" }), ["d1"], 1)).toBe("accepted");
  });

  it("cannot settle when the director roster is unknown", () => {
    expect(decisionStatus(decision({ d1: "yes", d2: "yes" }), [], 2)).toBe("in-review");
  });

  it("lets a recorded final outcome override the tally", () => {
    const split = decision(
      { d1: "yes", d2: "no" },
      { final: { outcome: "yes", by: "d3", at: "2026-09-10T00:00:00Z" } },
    );
    expect(decisionStatus(split, DIRECTORS, 2)).toBe("accepted");

    const flipped = { ...split, final: { outcome: "no" as const, by: "d3", at: "x" } };
    expect(decisionStatus(flipped, DIRECTORS, 2)).toBe("rejected");
  });
});

describe("isSettled", () => {
  it("covers exactly the two terminal statuses", () => {
    expect(isSettled("accepted")).toBe(true);
    expect(isSettled("rejected")).toBe(true);
    expect(isSettled("discussing")).toBe(false);
    expect(isSettled("in-review")).toBe(false);
  });
});

describe("feedback", () => {
  const withFeedback = (ids: string[]): Decision =>
    decision(
      {},
      {
        feedback: Object.fromEntries(
          ids.map((id) => [id, { text: `notes from ${id}`, at: "2026-09-10T00:00:00Z" }]),
        ),
      },
    );

  it("reports progress without revealing anything", () => {
    expect(feedbackProgress(withFeedback(["d1", "d2"]), DIRECTORS)).toEqual({
      submitted: 2,
      total: 3,
      complete: false,
    });
  });

  it("stays hidden until every director has written", () => {
    expect(feedbackFields(withFeedback(["d1", "d2"]), DIRECTORS)).toEqual([]);
  });

  it("reveals everyone's once the last one lands", () => {
    const fields = feedbackFields(withFeedback(DIRECTORS), DIRECTORS);
    expect(fields).toHaveLength(3);
    expect(fields[0]?.value).toContain("notes from d1");
  });

  it("treats an empty string as not submitted", () => {
    const partial = decision({}, { feedback: { d1: { text: "", at: "x" } } });
    expect(feedbackProgress(partial, ["d1"]).complete).toBe(false);
  });

  it("never completes when the roster is empty", () => {
    expect(feedbackProgress(emptyDecision(), []).complete).toBe(false);
  });
});

describe("renderDecision", () => {
  it("shows the tally and who voted which way", () => {
    const text = renderDecision(decision({ d1: "yes", d2: "hold" }), DIRECTORS, 2);
    expect(text).toContain("Yes 1 · No 0 · Discuss 1");
    expect(text).toContain("<@d1>");
  });

  it("asks for a recorded outcome when the vote splits", () => {
    const text = renderDecision(decision({ d1: "yes", d2: "no" }), DIRECTORS, 2);
    expect(text).toContain("Discussing");
    expect(text).toContain("records the outcome");
  });

  it("attributes a final outcome to whoever recorded it", () => {
    const text = renderDecision(
      decision({ d1: "yes", d2: "no" }, { final: { outcome: "yes", by: "d3", at: "x" } }),
      DIRECTORS,
      2,
    );
    expect(text).toContain("Final: yes");
    expect(text).toContain("<@d3>");
  });

  it("says so when the roster isn't configured", () => {
    expect(renderDecision(decision({ d1: "yes" }), [], 2)).toContain("director_ids");
  });
});

describe("outcomeTemplateKey", () => {
  it("picks the acceptance and waitlist templates", () => {
    expect(outcomeTemplateKey("welcomed", false)).toBe("acceptance");
    expect(outcomeTemplateKey("waitlisted", true)).toBe("waitlist notice");
  });

  it("picks the rejection template that matches what they asked for", () => {
    expect(outcomeTemplateKey("rejected", true)).toBe("rejection with feedback");
    expect(outcomeTemplateKey("rejected", false)).toBe("rejection without feedback");
  });
});

describe("renderOutcomeLine", () => {
  const at = "2026-09-10T00:00:00Z";

  it("flags an outcome whose email is drafted but unsent", () => {
    const line = renderOutcomeLine({ outcome: "welcomed", by: "d1", at });
    expect(line).toContain("not sent yet");
    expect(line).toContain("<@d1>");
  });

  it("drops the warning once it has actually gone", () => {
    const line = renderOutcomeLine({ outcome: "rejected", by: "d1", at, sentAt: at });
    expect(line).toContain("notice sent");
    expect(line).not.toContain("not sent yet");
  });

  it("covers every outcome", () => {
    for (const outcome of ["welcomed", "rejected", "waitlisted"] as const) {
      expect(renderOutcomeLine({ outcome, by: "d1", at })).toBeTruthy();
    }
  });
});
