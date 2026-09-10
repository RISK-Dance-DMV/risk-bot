import { describe, expect, it } from "vitest";
import { buildSheetRowUrl } from "../src/applications/sheetLink";

const CONFIGURED =
  "https://docs.google.com/spreadsheets/d/1sVrn-TsQhlTfiQ1s7KIONEkAmMgx4BbJMGMURK4t8G8/edit?resourcekey=&gid=279287741#gid=279287741";

describe("buildSheetRowUrl", () => {
  it("keeps the configured tab's gid rather than assuming 0", () => {
    const url = buildSheetRowUrl(CONFIGURED, 12);
    expect(url).toBe(
      "https://docs.google.com/spreadsheets/d/1sVrn-TsQhlTfiQ1s7KIONEkAmMgx4BbJMGMURK4t8G8/edit?gid=279287741#gid=279287741&range=A12",
    );
  });

  it("reads a gid that appears only in the fragment", () => {
    const url = buildSheetRowUrl(
      "https://docs.google.com/spreadsheets/d/ABC/edit#gid=99",
      5,
    );
    expect(url).toContain("gid=99");
    expect(url).toContain("range=A5");
  });

  it("falls back to gid 0 when the URL carries none", () => {
    const url = buildSheetRowUrl("https://docs.google.com/spreadsheets/d/ABC/edit", 5);
    expect(url).toContain("gid=0");
  });

  it("drops the empty resourcekey rather than passing it through", () => {
    expect(buildSheetRowUrl(CONFIGURED, 12)).not.toContain("resourcekey");
  });

  it("returns undefined for anything that isn't a spreadsheet URL", () => {
    expect(buildSheetRowUrl("", 12)).toBeUndefined();
    expect(buildSheetRowUrl("not a url", 12)).toBeUndefined();
    expect(buildSheetRowUrl("https://docs.google.com/document/d/ABC/edit", 12)).toBeUndefined();
  });

  it("returns undefined for a nonsense row", () => {
    expect(buildSheetRowUrl(CONFIGURED, 0)).toBeUndefined();
    expect(buildSheetRowUrl(CONFIGURED, 1.5)).toBeUndefined();
  });
});
