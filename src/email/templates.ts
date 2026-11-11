/**
 * Email templates (design doc rank 27). Pure.
 *
 * Templates live as sheet rows - template_key | subject | body | notes - with
 * merge fields written {{name}}.
 *
 * Rendering happens here rather than in Apps Script so the director sees the
 * exact text before approving it, and can edit it. "Every send is gated by a
 * click" only means something if the thing being clicked is the real message.
 */
import type { SheetPage } from "../appsScript";

export interface Template {
  key: string;
  subject: string;
  body: string;
  notes?: string;
}

/** The set the doc calls for. Most belong to ranks that aren't built yet. */
export const EXPECTED_TEMPLATE_KEYS = [
  "interview invitation",
  "acceptance",
  "rejection with feedback",
  "rejection without feedback",
  "waitlist notice",
  "dance settlement",
  "session charge",
  "refund confirmation",
] as const;

/**
 * Deliberately greedy about what counts as a merge field: anything between
 * double braces, including spaces, commas and parentheses.
 *
 * A narrower pattern is worse than useless here. `{{DATE, TIME}}` wouldn't match
 * it, so it would sail past the unfilled-field check and get emailed to a real
 * applicant verbatim — the exact failure that check exists to prevent. Better to
 * treat anything brace-wrapped as a field and refuse to send.
 */
const MERGE_FIELD = /\{\{\s*([^{}]*?)\s*\}\}/g;

function columnIndex(headers: readonly string[], name: string): number {
  return headers.findIndex(
    (h) => (h ?? "").trim().toLowerCase().replace(/\s+/g, "_") === name,
  );
}

/**
 * Reads the template sheet by header name. Unlike the application form, this
 * sheet is ours and its headers don't repeat, so names are safe here.
 */
export function parseTemplates(page: SheetPage): Template[] {
  const keyAt = columnIndex(page.headers, "template_key");
  const subjectAt = columnIndex(page.headers, "subject");
  const bodyAt = columnIndex(page.headers, "body");
  const notesAt = columnIndex(page.headers, "notes");

  if (keyAt === -1 || subjectAt === -1 || bodyAt === -1) return [];

  const templates: Template[] = [];
  for (const row of page.rows) {
    const key = (row.values[keyAt] ?? "").trim();
    if (!key) continue;
    const notes = notesAt === -1 ? "" : (row.values[notesAt] ?? "").trim();
    templates.push({
      key,
      subject: (row.values[subjectAt] ?? "").trim(),
      body: (row.values[bodyAt] ?? "").trim(),
      ...(notes ? { notes } : {}),
    });
  }
  return templates;
}

/**
 * Template keys and merge fields are matched loosely: case-insensitive, and
 * underscores/hyphens treated as spaces. `interview_invitation` and
 * `Interview Invitation` are the same template; `{{NAME}}` and `{{name}}` are the
 * same field. Whoever writes the sheet shouldn't have to guess a convention.
 */
function loosely(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function findTemplate(templates: Template[], key: string): Template | undefined {
  const wanted = loosely(key);
  return templates.find((t) => loosely(t.key) === wanted);
}

export function mergeFieldsIn(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(MERGE_FIELD), (m) => m[1] ?? ""))];
}

export type RenderResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; reason: string };

/**
 * Whitespace a template picks up from being written in a spreadsheet cell.
 *
 * Gmail renders these as plain text, and it collapses any long run of blank
 * lines behind a "•••" toggle — so a template spaced out for legibility in the
 * sheet arrives with a hole punched in the middle of it. Runs of three or more
 * newlines become a single blank line; trailing spaces go too, since they
 * survive into the rendered mail as ragged indentation.
 */
export function tidyBody(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    // Invisible characters first, or the blank-line collapse below never fires:
    // a "blank" line holding a non-breaking space is not two adjacent newlines.
    // Text written in Google Docs and pasted into the sheet is full of these.
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Substitutes merge fields, and refuses if any are left over.
 *
 * A template that renders to "Hi {{name}}" would go out looking exactly like
 * that, to a real applicant, once. Better to fail before the draft exists.
 */
export function renderTemplate(
  template: Template,
  merge: Record<string, string>,
): RenderResult {
  const byLooseName = new Map<string, string>();
  // Blank values deliberately don't fill a field - a template asking for
  // {{feedback}} and getting nothing should refuse, not send a sentence that
  // trails off. But the refusal has to say which of the two happened.
  const leftBlank = new Set<string>();
  for (const [field, value] of Object.entries(merge)) {
    if (value === "") leftBlank.add(loosely(field));
    else byLooseName.set(loosely(field), value);
  }

  const substitute = (text: string): string =>
    text.replace(MERGE_FIELD, (whole, field: string) => {
      return byLooseName.get(loosely(field)) ?? whole;
    });

  const subject = substitute(template.subject);
  const body = tidyBody(substitute(template.body));

  const unresolved = [...new Set([...mergeFieldsIn(subject), ...mergeFieldsIn(body)])];
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: `Template "${template.key}" has unfilled merge field(s): ${unresolved
        .map((f) =>
          leftBlank.has(loosely(f))
            ? `{{${f}}} — you left that box empty, and this template needs it`
            : `{{${f}}} — nothing here fills that; check the spelling in the sheet`,
        )
        .join(", ")}`,
    };
  }

  if (!subject) return { ok: false, reason: `Template "${template.key}" has no subject.` };
  if (!body) return { ok: false, reason: `Template "${template.key}" has no body.` };

  return { ok: true, subject, body };
}

export function missingTemplates(
  templates: Template[],
  required: readonly string[] = EXPECTED_TEMPLATE_KEYS,
): string[] {
  return required.filter((key) => !findTemplate(templates, key));
}
