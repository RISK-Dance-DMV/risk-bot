import { describe, expect, it } from "vitest";
import { outcomeFeedbackModal } from "../src/applications/outcome";
import type { CardRecord } from "../src/applications/intake";
import { emptyDecision } from "../src/applications/decision";

const DIRECTORS = ["d1", "d2", "d3"];

const recordWith = (feedback: Record<string, string>): CardRecord =>
  ({
    row: 12,
    messageId: "m",
    channelId: "c",
    method: "video_submission",
    state: "open",
    waitingSince: "2026-09-01T00:00:00Z",
    decision: {
      ...emptyDecision(),
      feedback: Object.fromEntries(
        Object.entries(feedback).map(([id, text]) => [id, { text, at: "x" }]),
      ),
    },
  }) as CardRecord;

const field = (modal: unknown) =>
  (
    modal as {
      data: { components: { components: { value?: string; label?: string }[] }[] };
    }
  ).data.components[0]?.components[0];

describe("the applicant-facing feedback box", () => {
  it("compiles every director's note", () => {
    const value = field(
      outcomeFeedbackModal(12, recordWith({ d1: "one", d2: "two", d3: "three" }), DIRECTORS),
    )?.value;
    expect(value).toBe("one\n\ntwo\n\nthree");
  });

  /** Same order as the card's feedback fields, so the text is reproducible. */
  it("walks the roster, not whichever director happened to write first", () => {
    const value = field(
      outcomeFeedbackModal(12, recordWith({ d3: "three", d1: "one" }), DIRECTORS),
    )?.value;
    expect(value).toBe("one\n\nthree");
  });

  it("skips a note from someone no longer on the roster", () => {
    const value = field(
      outcomeFeedbackModal(12, recordWith({ d1: "one", exDirector: "stale" }), DIRECTORS),
    )?.value;
    expect(value).toBe("one");
  });

  it("skips a director who left the box empty", () => {
    const value = field(
      outcomeFeedbackModal(12, recordWith({ d1: "one", d2: "   ", d3: "three" }), DIRECTORS),
    )?.value;
    expect(value).toBe("one\n\nthree");
  });

  it("says in the label how many notes it composed", () => {
    expect(field(outcomeFeedbackModal(12, recordWith({ d1: "one" }), DIRECTORS))?.label).toBe(
      "They will read this — from 1 director note",
    );
    expect(
      field(outcomeFeedbackModal(12, recordWith({ d1: "one", d2: "two" }), DIRECTORS))?.label,
    ).toBe("They will read this — from 2 director notes");
  });

  it("says nothing about notes when there are none", () => {
    expect(field(outcomeFeedbackModal(12, recordWith({}), DIRECTORS))?.label).toBe(
      "They will read this",
    );
    expect(field(outcomeFeedbackModal(12, recordWith({}), DIRECTORS))?.value).toBe("");
  });
});

describe("re-opening the box after an outcome was composed", () => {
  const withOutcome = (composed: string): CardRecord =>
    ({
      ...recordWith({ d1: "meowwww" }),
      outcome: { outcome: "welcomed", by: "d1", at: "x", feedback: composed },
    }) as CardRecord;

  /**
   * The confusion this fixes: compose "its ok", send it, reopen, and find
   * "meowwww" back in the box — the raw director note it had been edited away
   * from. It reads like the box forgot, or like the wrong applicant's text.
   */
  it("shows what was actually composed, not the notes it was composed from", () => {
    expect(field(outcomeFeedbackModal(12, withOutcome("its ok"), DIRECTORS))?.value).toBe(
      "its ok",
    );
  });

  it("says the prefill is the last version rather than a note count", () => {
    expect(field(outcomeFeedbackModal(12, withOutcome("its ok"), DIRECTORS))?.label).toBe(
      "They will read this — your last version",
    );
  });

  it("falls back to the notes when the last version was blank", () => {
    expect(field(outcomeFeedbackModal(12, withOutcome("   "), DIRECTORS))?.value).toBe(
      "meowwww",
    );
  });
});
