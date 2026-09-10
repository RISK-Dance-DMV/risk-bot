import { describe, expect, it } from "vitest";
import {
  agreedPlacement,
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
  it("counts votes per subunit, not for and against", () => {
    const t = tally(
      decision({ d1: ["Hearts"], d2: ["Hearts", "Clubs"], d3: [] }),
    );
    expect(t.bySubunit).toEqual({ Hearts: 2, Clubs: 1 });
    expect(t.no).toBe(1);
    expect(t.cast).toBe(3);
  });

  it("keeps a hold out of the vote count", () => {
    const t = tally(decision({ d1: ["Hearts"], d2: "hold" }));
    expect(t).toMatchObject({ hold: 1, cast: 1 });
  });
});

describe("hasSplit", () => {
  it("treats any difference as a split, including a superset", () => {
    expect(hasSplit(decision({ d1: ["Hearts"], d2: ["Hearts", "Clubs"] }))).toBe(true);
  });

  it("is false when the ballots match", () => {
    expect(hasSplit(decision({ d1: ["Hearts"], d2: ["Hearts"] }))).toBe(false);
  });

  it("ignores the order subunits were picked in", () => {
    expect(
      hasSplit(decision({ d1: ["Hearts", "Clubs"], d2: ["Clubs", "Hearts"] })),
    ).toBe(false);
  });

  it("counts accept-nobody against accept-someone as a split", () => {
    expect(hasSplit(decision({ d1: ["Hearts"], d2: [] }))).toBe(true);
  });

  it("is false with a single ballot, or none", () => {
    expect(hasSplit(decision({ d1: ["Hearts"] }))).toBe(false);
    expect(hasSplit(emptyDecision())).toBe(false);
  });

  it("ignores holds when looking for disagreement", () => {
    expect(hasSplit(decision({ d1: ["Hearts"], d2: "hold" }))).toBe(false);
  });
});

describe("agreedPlacement", () => {
  it("returns the set everyone voted", () => {
    expect(
      agreedPlacement(
        decision({ d1: ["Hearts", "Clubs"], d2: ["Clubs", "Hearts"], d3: ["Hearts", "Clubs"] }),
        DIRECTORS,
      ),
    ).toEqual(["Clubs", "Hearts"]);
  });

  it("returns an empty placement when everyone voted none", () => {
    expect(agreedPlacement(decision({ d1: [], d2: [], d3: [] }), DIRECTORS)).toEqual([]);
  });

  it("is null while a director hasn't voted", () => {
    expect(agreedPlacement(decision({ d1: ["Hearts"], d2: ["Hearts"] }), DIRECTORS)).toBeNull();
  });

  it("is null when a director is holding", () => {
    expect(
      agreedPlacement(decision({ d1: ["Hearts"], d2: ["Hearts"], d3: "hold" }), DIRECTORS),
    ).toBeNull();
  });

  it("is null when they didn't vote the same", () => {
    expect(
      agreedPlacement(
        decision({ d1: ["Hearts"], d2: ["Hearts"], d3: ["Hearts", "Clubs"] }),
        DIRECTORS,
      ),
    ).toBeNull();
  });
});

describe("decisionStatus", () => {
  it("is new before anyone votes", () => {
    expect(decisionStatus(emptyDecision(), DIRECTORS, 2)).toBe("new");
  });

  it("is in-review while votes are still coming in", () => {
    expect(decisionStatus(decision({ d1: ["Hearts"] }), DIRECTORS, 2)).toBe("in-review");
  });

  it("flips to discussing as soon as two ballots differ", () => {
    expect(
      decisionStatus(decision({ d1: ["Hearts"], d2: ["Clubs"] }), DIRECTORS, 2),
    ).toBe("discussing");
  });

  it("treats Hearts against Hearts+Clubs as a discussion, not a narrower yes", () => {
    expect(
      decisionStatus(
        decision({ d1: ["Hearts"], d2: ["Hearts"], d3: ["Hearts", "Clubs"] }),
        DIRECTORS,
        2,
      ),
    ).toBe("discussing");
  });

  it("accepts when every director voted the same non-empty placement", () => {
    expect(
      decisionStatus(
        decision({ d1: ["Hearts"], d2: ["Hearts"], d3: ["Hearts"] }),
        DIRECTORS,
        2,
      ),
    ).toBe("accepted");
  });

  it("rejects when every director voted none", () => {
    expect(decisionStatus(decision({ d1: [], d2: [], d3: [] }), DIRECTORS, 2)).toBe(
      "rejected",
    );
  });

  it("holds settlement while a [Need to discuss] is outstanding", () => {
    expect(
      decisionStatus(
        decision({ d1: ["Hearts"], d2: ["Hearts"], d3: "hold" }),
        DIRECTORS,
        2,
      ),
    ).toBe("in-review");
  });

  it("respects the minimum-votes floor", () => {
    expect(decisionStatus(decision({ d1: ["Hearts"] }), ["d1"], 2)).toBe("in-review");
    expect(decisionStatus(decision({ d1: ["Hearts"] }), ["d1"], 1)).toBe("accepted");
  });

  it("cannot settle when the director roster is unknown", () => {
    expect(decisionStatus(decision({ d1: ["Hearts"], d2: ["Hearts"] }), [], 2)).toBe(
      "in-review",
    );
  });

  it("lets a recorded outcome override the tally", () => {
    const split = decision(
      { d1: ["Hearts"], d2: [] },
      { final: { outcome: "yes", by: "d3", at: "2026-09-10T00:00:00Z" } },
    );
    expect(decisionStatus(split, DIRECTORS, 2)).toBe("accepted");
    expect(
      decisionStatus({ ...split, final: { outcome: "no", by: "d3", at: "x" } }, DIRECTORS, 2),
    ).toBe("rejected");
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
});

describe("renderDecision", () => {
  it("shows per-subunit counts and how each director voted", () => {
    const text = renderDecision(
      decision({ d1: ["Hearts"], d2: ["Hearts", "Clubs"] }),
      DIRECTORS,
      2,
    );
    expect(text).toContain("Clubs 1");
    expect(text).toContain("Hearts 2");
    expect(text).toContain("<@d1> — Hearts");
  });

  it("names who hasn't voted yet", () => {
    const text = renderDecision(decision({ d1: ["Hearts"] }), DIRECTORS, 2);
    expect(text).toContain("<@d2> — *yet to vote*");
  });

  it("shows a vote for nobody as none", () => {
    expect(renderDecision(decision({ d1: [] }), DIRECTORS, 2)).toContain("<@d1> — none");
  });

  it("states the agreed placement once they all match", () => {
    const text = renderDecision(
      decision({ d1: ["Hearts"], d2: ["Hearts"], d3: ["Hearts"] }),
      DIRECTORS,
      2,
    );
    expect(text).toContain("Agreed: Hearts");
  });

  it("asks for a recorded outcome when they disagree", () => {
    const text = renderDecision(decision({ d1: ["Hearts"], d2: ["Clubs"] }), DIRECTORS, 2);
    expect(text).toContain("Discussing");
    expect(text).toContain("records the outcome");
  });

  it("attributes a decision made after discussion", () => {
    const text = renderDecision(
      decision({ d1: ["Hearts"], d2: [] }, { final: { outcome: "yes", by: "d3", at: "x" } }),
      DIRECTORS,
      2,
    );
    expect(text).toContain("Moving onto interview");
    expect(text).toContain("<@d3>");
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
    expect(line).toContain("email sent");
    expect(line).not.toContain("not sent yet");
  });

  it("names the placement on an acceptance", () => {
    const line = renderOutcomeLine({
      outcome: "welcomed",
      by: "d1",
      at,
      subunits: ["Hearts", "Clubs"],
    });
    expect(line).toContain("Hearts, Clubs");
  });
});
