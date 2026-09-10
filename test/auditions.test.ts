import { describe, expect, it } from "vitest";
import { indexByEmail, normalizeEmail } from "../src/applications/auditions";
import type { SheetPage } from "../src/appsScript";

/** Application sheet: C is email. */
const page = (rows: { row: number; email: string }[]): SheetPage => ({
  headers: ["Timestamp", "", "Email Address", "Type", "Name"],
  rows: rows.map(({ row, email }) => ({
    row,
    values: ["ts", "", email, "Dancer", "Someone"],
  })),
});

describe("normalizeEmail", () => {
  it("trims and lowercases so casing doesn't break a match", () => {
    expect(normalizeEmail("  Mimi@Example.COM ")).toBe("mimi@example.com");
  });
});

describe("indexByEmail", () => {
  it("maps each application email to its row", () => {
    const index = indexByEmail(page([{ row: 2, email: "a@b.com" }, { row: 3, email: "c@d.com" }]));
    expect(index.get("a@b.com")).toBe(2);
    expect(index.get("c@d.com")).toBe(3);
  });

  it("matches regardless of the casing used on either form", () => {
    const index = indexByEmail(page([{ row: 2, email: " Mimi@Example.com " }]));
    expect(index.get("mimi@example.com")).toBe(2);
  });

  it("keeps the most recent application when someone applies twice", () => {
    const index = indexByEmail(
      page([
        { row: 2, email: "a@b.com" },
        { row: 9, email: "a@b.com" },
        { row: 5, email: "a@b.com" },
      ]),
    );
    expect(index.get("a@b.com")).toBe(9);
  });

  it("skips rows with no email rather than indexing an empty key", () => {
    const index = indexByEmail(page([{ row: 2, email: "" }, { row: 3, email: "c@d.com" }]));
    expect(index.size).toBe(1);
  });
});
