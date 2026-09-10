/**
 * Form registry configuration (design doc rank 21).
 */
import { indexToCol } from "../applications/fields";

export type FormType = "application" | "audition";

export const FORM_TYPES: FormType[] = ["application", "audition"];

export function isFormType(value: string): value is FormType {
  return (FORM_TYPES as string[]).includes(value);
}

/**
 * Preferred column for the audition form's email, or null to detect it from the
 * headers at registration time.
 *
 * The doc pins C/D/E on the *application* sheet because its repeating headers
 * make read-by-name unusable there. The audition form is a different, much
 * smaller form, so the letter is resolved once at registration and then stored -
 * pinned from that moment, rather than re-guessed on every read.
 */
export const AUDITION_EMAIL_COLUMN: string | null = null;

export interface EmailColumnResolution {
  column: string | null;
  detail: string;
}

/**
 * Finds the column audition submissions are matched on. Refusing here is the
 * point: a form we can't match submissions from would silently let RISK-process
 * applicants close at 14 days despite having auditioned.
 */
export function resolveEmailColumn(
  headers: readonly string[],
  preferred: string | null = AUDITION_EMAIL_COLUMN,
): EmailColumnResolution {
  if (preferred) {
    const found = (headers[colIndex(preferred)] ?? "").trim();
    if (!found) {
      return { column: null, detail: `column ${preferred} has no header` };
    }
    if (!found.toLowerCase().includes("email")) {
      return {
        column: null,
        detail: `column ${preferred} is "${found}", which doesn't look like an email field`,
      };
    }
    return { column: preferred, detail: `column ${preferred} ("${found}")` };
  }

  const index = headers.findIndex((h) => (h ?? "").toLowerCase().includes("email"));
  if (index === -1) {
    return { column: null, detail: "no header on that form contains \"email\"" };
  }
  const column = indexToCol(index);
  return { column, detail: `column ${column} ("${(headers[index] ?? "").trim()}")` };
}

/** Local copy to avoid a circular import at module init. */
function colIndex(col: string): number {
  let n = 0;
  for (const ch of col.trim().toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
