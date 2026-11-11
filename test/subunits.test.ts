import { describe, expect, it } from "vitest";
import {
  formatSubunits,
  formatSubunitsLong,
  placementOptions,
  subunitsAppliedFor,
  SUBUNIT_GLOSS,
  SUBUNITS,
} from "../src/config/subunits";

describe("subunitsAppliedFor", () => {
  it("reads a comma-separated checkbox answer", () => {
    expect(subunitsAppliedFor("Hearts, Spades")).toEqual(["Spades", "Hearts"]);
  });

  it("copes with the shapes a form actually produces", () => {
    expect(subunitsAppliedFor("Hearts and Clubs")).toEqual(["Hearts", "Clubs"]);
    expect(subunitsAppliedFor("hearts/spades")).toEqual(["Spades", "Hearts"]);
    expect(subunitsAppliedFor("  CLUBS  ")).toEqual(["Clubs"]);
  });

  it("returns them in a consistent order, not the answer's order", () => {
    expect(subunitsAppliedFor("Clubs, Hearts, Spades")).toEqual([
      "Spades",
      "Hearts",
      "Clubs",
    ]);
  });

  it("finds a subunit named inside a sentence", () => {
    expect(subunitsAppliedFor("I'd love to be considered for Hearts")).toEqual(["Hearts"]);
  });

  it("doesn't match a subunit buried in another word", () => {
    expect(subunitsAppliedFor("heartsick")).toEqual([]);
    expect(subunitsAppliedFor("nightclubbing")).toEqual([]);
  });

  it("returns nothing for a blank or unrecognisable answer", () => {
    expect(subunitsAppliedFor("")).toEqual([]);
    expect(subunitsAppliedFor("whichever you think")).toEqual([]);
  });
});

describe("placementOptions", () => {
  it("offers only what they auditioned for", () => {
    expect(placementOptions("Hearts, Clubs")).toEqual({
      options: ["Hearts", "Clubs"],
      fellBack: false,
    });
  });

  it("falls back to every subunit rather than blocking the decision", () => {
    expect(placementOptions("whichever you think")).toEqual({
      options: [...SUBUNITS],
      fellBack: true,
    });
  });
});

describe("formatSubunits", () => {
  it("reads the way a person would write it", () => {
    expect(formatSubunits(["Hearts"])).toBe("Hearts");
    expect(formatSubunits(["Spades", "Hearts"])).toBe("Spades and Hearts");
    expect(formatSubunits(["Spades", "Hearts", "Clubs"])).toBe("Spades, Hearts and Clubs");
  });

  it("returns nothing for an empty placement", () => {
    expect(formatSubunits([])).toBe("");
  });
});

describe("formatSubunitsLong", () => {
  it("spells out what each unit is, for the applicant", () => {
    expect(formatSubunitsLong(["Spades"])).toBe("Spades (boy group unit)");
    expect(formatSubunitsLong(["Hearts", "Clubs"])).toBe(
      "Hearts (girl group unit) and Clubs (trainee unit)",
    );
  });

  it("leaves the director-facing form bare", () => {
    expect(formatSubunits(["Hearts", "Clubs"])).toBe("Hearts and Clubs");
  });

  it("glosses every subunit, so adding one can't ship half-labelled", () => {
    for (const unit of SUBUNITS) expect(SUBUNIT_GLOSS[unit]).toBeTruthy();
  });
});
