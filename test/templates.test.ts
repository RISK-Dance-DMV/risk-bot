import { describe, expect, it } from "vitest";
import {
  EXPECTED_TEMPLATE_KEYS,
  findTemplate,
  mergeFieldsIn,
  missingTemplates,
  parseTemplates,
  renderTemplate,
  tidyBody,
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

describe("loose matching (real sheets don't follow one convention)", () => {
  const templates: Template[] = [
    { key: "interview_invitation", subject: "s", body: "b" },
    { key: "rejection_with_feedback", subject: "s", body: "b" },
  ];

  it("matches an underscored key against a spaced one", () => {
    expect(findTemplate(templates, "interview invitation")?.key).toBe("interview_invitation");
    expect(findTemplate(templates, "rejection with feedback")?.key).toBe(
      "rejection_with_feedback",
    );
  });

  it("fills an uppercase merge field from a lowercase value", () => {
    const result = renderTemplate(
      { key: "k", subject: "Hi {{NAME}}", body: "See you {{SLOT}}" },
      { name: "Mimi", slot: "Sunday" },
    );
    expect(result).toMatchObject({ ok: true, subject: "Hi Mimi", body: "See you Sunday" });
  });
});

describe("merge fields that a narrow pattern would miss", () => {
  it("catches fields containing spaces, commas and parentheses", () => {
    expect(mergeFieldsIn("{{DATE, TIME}} {{SUBUNIT(s)}} {{DISCORD INVITE}}")).toEqual([
      "DATE, TIME",
      "SUBUNIT(s)",
      "DISCORD INVITE",
    ]);
  });

  it("refuses to send a template containing them rather than mailing them literally", () => {
    const result = renderTemplate(
      { key: "interview invitation", subject: "s", body: "does {{DATE, TIME}} work?" },
      { name: "Mimi" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("{{DATE, TIME}}");
  });

  it("still renders a template whose fields are all supplied", () => {
    const result = renderTemplate(
      { key: "k", subject: "s", body: "does {{DATE, TIME}} work?" },
      { "date, time": "Sunday 2pm" },
    );
    expect(result).toMatchObject({ ok: true, body: "does Sunday 2pm work?" });
  });
});

describe("tidyBody", () => {
  it("collapses the blank runs Gmail hides behind a ••• toggle", () => {
    expect(tidyBody("here:\n\nfeedback\n\n\n\n\nWe hope")).toBe(
      "here:\n\nfeedback\n\nWe hope",
    );
  });

  it("keeps ordinary paragraph breaks", () => {
    expect(tidyBody("one\n\ntwo\nthree")).toBe("one\n\ntwo\nthree");
  });

  it("drops trailing spaces that render as ragged indentation", () => {
    expect(tidyBody("line one   \nline two\t")).toBe("line one\nline two");
  });

  /**
   * The case that survived the first fix. Text pasted into the sheet from
   * Google Docs carries non-breaking spaces, so a line that looks blank isn't,
   * and a plain \n{3,} collapse never matches it.
   */
  it("collapses blank lines that are holding a non-breaking space", () => {
    expect(tidyBody("its ok\n\u00a0\n\u00a0\n\u00a0\nWe hope")).toBe("its ok\n\nWe hope");
  });

  it("collapses blank lines holding zero-width characters", () => {
    expect(tidyBody("a\n\u200b\n\u200b\nb")).toBe("a\n\nb");
  });

  it("keeps a non-breaking space that's doing real work mid-sentence", () => {
    expect(tidyBody("Spades\u00a0(boy group unit)")).toBe("Spades (boy group unit)");
  });

  it("normalises spreadsheet line endings", () => {
    expect(tidyBody("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
  });

  it("runs as part of rendering, so the draft matches the email", () => {
    const rendered = renderTemplate(
      { key: "acceptance", subject: "Welcome", body: "Hi {{name}},\n\n\n\n\nsee you" },
      { name: "Mimi" },
    );
    expect(rendered).toMatchObject({ ok: true, body: "Hi Mimi,\n\nsee you" });
  });
});

describe("why a merge field didn't fill", () => {
  const template = { key: "acceptance", subject: "Welcome", body: "Hi {{name}}. {{FEEDBACK}}" };

  it("says so when the value was supplied but blank", () => {
    const result = renderTemplate(template, { name: "Mimi", feedback: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("you left that box empty");
  });

  it("says something different when nothing supplies the field at all", () => {
    const result = renderTemplate(template, { name: "Mimi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("check the spelling in the sheet");
  });

  it("still refuses rather than sending a sentence that trails off", () => {
    expect(renderTemplate(template, { name: "Mimi", feedback: "" }).ok).toBe(false);
  });

  it("fills normally once there is something to fill with", () => {
    expect(renderTemplate(template, { name: "Mimi", feedback: "turn around" })).toMatchObject({
      ok: true,
      body: "Hi Mimi. turn around",
    });
  });
});
