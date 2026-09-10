import { describe, expect, it } from "vitest";
import {
  cell,
  classifyAuditionMethod,
  colToIndex,
  indexToCol,
  parseRow,
  verifyPinnedHeaders,
} from "../src/applications/fields";

describe("colToIndex", () => {
  it("maps single and double letters", () => {
    expect(colToIndex("A")).toBe(0);
    expect(colToIndex("C")).toBe(2);
    expect(colToIndex("Z")).toBe(25);
    expect(colToIndex("AA")).toBe(26);
    expect(colToIndex("ab")).toBe(27);
  });

  it("rejects nonsense", () => {
    expect(() => colToIndex("A1")).toThrow();
    expect(() => colToIndex("")).toThrow();
  });
});

describe("cell", () => {
  const values = ["ts", "", "a@b.com", "Dancer", "  Mimi  "];

  it("reads by letter and trims", () => {
    expect(cell(values, "C")).toBe("a@b.com");
    expect(cell(values, "E")).toBe("Mimi");
  });

  it("returns empty for unconfigured or out-of-range columns", () => {
    expect(cell(values, null)).toBe("");
    expect(cell(values, "Z")).toBe("");
  });
});

describe("verifyPinnedHeaders", () => {
  it("accepts a sheet whose C/D/E match", () => {
    const headers = [
      "Timestamp",
      "Score",
      "Email Address",
      "What are you applying for?",
      "Full name",
    ];
    expect(verifyPinnedHeaders(headers)).toEqual({ ok: true, problems: [] });
  });

  it("catches a shifted sheet rather than reading pronouns as names", () => {
    const headers = [
      "Timestamp",
      "Email Address",
      "What are you applying for?",
      "Full name",
      "Pronouns",
    ];
    const check = verifyPinnedHeaders(headers);
    expect(check.ok).toBe(false);
    expect(check.problems).toHaveLength(3);
    expect(check.problems[2]).toContain("Pronouns");
  });

  it("reports empty header cells", () => {
    const check = verifyPinnedHeaders(["Timestamp"]);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain("empty cell");
  });
});

describe("parseRow", () => {
  it("pulls the three pinned fields", () => {
    const row = parseRow(7, ["ts", "", "a@b.com", "Dancer", "Mimi", "extra"]);
    expect(row).toMatchObject({ row: 7, email: "a@b.com", applicantType: "Dancer", name: "Mimi" });
  });
});

describe("classifyAuditionMethod", () => {
  it("recognises the two live answers", () => {
    expect(classifyAuditionMethod("Existing dance video submission and interview")).toBe(
      "video_submission",
    );
    expect(classifyAuditionMethod("RISK Audition process")).toBe("risk_process");
    expect(classifyAuditionMethod("risk audition process")).toBe("risk_process");
  });

  it("does not guess at a blank or unexpected answer", () => {
    expect(classifyAuditionMethod("")).toBe("unknown");
    expect(classifyAuditionMethod("not sure yet")).toBe("unknown");
  });
});

describe("parseRow — audition method", () => {
  it("reads column AL and keeps the raw text", () => {
    const values = new Array(42).fill("");
    values[3] = "Dancer";
    values[4] = "Mimi";
    values[37] = "RISK Audition process";
    const row = parseRow(12, values);
    expect(row.auditionMethod).toBe("risk_process");
    expect(row.auditionMethodRaw).toBe("RISK Audition process");
  });
});

describe("indexToCol", () => {
  it("inverts colToIndex", () => {
    expect(indexToCol(0)).toBe("A");
    expect(indexToCol(2)).toBe("C");
    expect(indexToCol(25)).toBe("Z");
    expect(indexToCol(26)).toBe("AA");
    expect(indexToCol(37)).toBe("AL");
    expect(indexToCol(41)).toBe("AP");
  });

  it("round-trips every column the sheet could plausibly use", () => {
    for (let i = 0; i < 200; i++) expect(colToIndex(indexToCol(i))).toBe(i);
  });
});
