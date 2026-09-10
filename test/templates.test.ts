import { describe, expect, it } from "vitest";
import {
  EXPECTED_TEMPLATE_KEYS,
  findTemplate,
  mergeFieldsIn,
  missingTemplates,
  parseTemplates,
  renderTemplate,
  type Template,
} from "../src/email/templates";
import type { SheetPage } from "../src/appsScript";

const page = (rows: string[][], headers = ["template_key", "subject", "body", "notes"]): SheetPage => ({
  headers,
  rows: rows.map((values, i) => ({ row: i + 2, values })),
});

describe("parseTemplates", () => {
  it("reads rows by header name", () => {
    const templates = parseTemplates(
      page([["acceptance", "You're in", "Hi {{name}}!", "keep it short"]]),
    );
    expect(templates).toEqual([
      { key: "acceptance", subject: "You're in", body: "Hi {{name}}!", notes: "keep it short" },
    ]);
  });

  it("tolerates header casing and spacing", () => {
    const templates = parseTemplates(
      page([["acceptance", "s", "b", ""]], ["Template Key", "Subject", "Body", "Notes"]),
    );
    expect(templates).toHaveLength(1);
  });

  it("skips rows with no key", () => {
    expect(parseTemplates(page([["", "s", "b", ""]]))).toEqual([]);
  });

  it("returns nothing when the sheet is missing a required column", () => {
    expect(parseTemplates(page([["acceptance", "s"]], ["template_key", "subject"]))).toEqual([]);
  });
});

describe("findTemplate", () => {
  const templates: Template[] = [{ key: "Interview Invitation", subject: "s", body: "b" }];

  it("matches case-insensitively", () => {
    expect(findTemplate(templates, "interview invitation")?.key).toBe("Interview Invitation");
  });

  it("returns undefined for an unknown key", () => {
    expect(findTemplate(templates, "acceptance")).toBeUndefined();
  });
});

describe("mergeFieldsIn", () => {
  it("finds fields and de-duplicates them", () => {
    expect(mergeFieldsIn("Hi {{name}}, see you {{when}}. Bye {{name}}")).toEqual(["name", "when"]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(mergeFieldsIn("{{ name }}")).toEqual(["name"]);
  });
});

describe("renderTemplate", () => {
  const template: Template = {
    key: "interview invitation",
    subject: "RISK interview — {{name}}",
    body: "Hi {{name}}, can you do {{slot}}?",
  };

  it("substitutes in both subject and body", () => {
    const result = renderTemplate(template, { name: "Mimi", slot: "Saturday 2pm" });
    expect(result).toEqual({
      ok: true,
      subject: "RISK interview — Mimi",
      body: "Hi Mimi, can you do Saturday 2pm?",
    });
  });

  it("refuses rather than mailing someone a literal {{name}}", () => {
    const result = renderTemplate(template, { name: "Mimi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("{{slot}}");
  });

  it("treats an empty merge value as unfilled", () => {
    const result = renderTemplate(template, { name: "Mimi", slot: "" });
    expect(result.ok).toBe(false);
  });

  it("refuses a template with no subject or no body", () => {
    expect(renderTemplate({ key: "k", subject: "", body: "b" }, {}).ok).toBe(false);
    expect(renderTemplate({ key: "k", subject: "s", body: "" }, {}).ok).toBe(false);
  });

  it("ignores merge values the template doesn't use", () => {
    const result = renderTemplate({ key: "k", subject: "s", body: "b" }, { extra: "x" });
    expect(result).toMatchObject({ ok: true, subject: "s", body: "b" });
  });
});

describe("missingTemplates", () => {
  it("lists what the doc calls for and the sheet lacks", () => {
    const templates: Template[] = [{ key: "acceptance", subject: "s", body: "b" }];
    const missing = missingTemplates(templates);
    expect(missing).not.toContain("acceptance");
    expect(missing).toContain("interview invitation");
    expect(missing).toHaveLength(EXPECTED_TEMPLATE_KEYS.length - 1);
  });
});
