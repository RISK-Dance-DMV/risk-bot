/**
 * Column addressing and header verification. Pure - no Worker APIs, no network.
 */
import {
  AUDITION_METHOD_COLUMN,
  AUDITION_METHOD_MATCH,
  NAME_COLUMNS,
  PINNED,
  PINNED_HEADER_MATCH,
  type AuditionMethod,
} from "../config/columns";

/** "A" -> 0, "C" -> 2, "AA" -> 26. */
export function colToIndex(col: string): number {
  const letters = col.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(letters)) throw new Error(`bad column: ${col}`);
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 -> "A", 26 -> "AA". Inverse of colToIndex. */
export function indexToCol(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`bad index: ${index}`);
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function cell(values: readonly string[], col: string | null): string {
  if (!col) return "";
  return (values[colToIndex(col)] ?? "").toString().trim();
}

export interface HeaderCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Verifies the three columns the design doc pins (C email, D applicant type,
 * E name). On mismatch the caller stops and posts rather than reading, say,
 * pronouns as names.
 */
export function verifyPinnedHeaders(headers: readonly string[]): HeaderCheck {
  const problems: string[] = [];
  for (const [col, expected] of Object.entries(PINNED_HEADER_MATCH)) {
    const found = (headers[colToIndex(col)] ?? "").toString().trim();
    if (!found) {
      problems.push(`${col}: expected a header containing "${expected}", found an empty cell`);
    } else if (!found.toLowerCase().includes(expected.toLowerCase())) {
      problems.push(`${col}: expected a header containing "${expected}", found "${found}"`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * "Chosen audition method" (column AL). An unrecognised or blank answer is
 * classified `unknown` and surfaced on the card rather than guessed at - the two
 * methods lead to different follow-up, so guessing wrong strands the applicant.
 */
export function classifyAuditionMethod(raw: string): AuditionMethod {
  for (const { method, pattern } of AUDITION_METHOD_MATCH) {
    if (pattern.test(raw)) return method;
  }
  return "unknown";
}

export interface ApplicationRow {
  row: number;
  email: string;
  applicantType: string;
  name: string;
  /** Raw cell text, kept so an unrecognised answer can be shown verbatim. */
  auditionMethodRaw: string;
  auditionMethod: AuditionMethod;
  values: readonly string[];
}

/**
 * Whether the applicant asked for feedback, which picks between the two
 * rejection templates. Anything that isn't a clear yes counts as no — the
 * quieter template is the safer one to pick wrongly.
 */
export function wantsFeedback(answer: string): boolean {
  return /\byes\b/i.test(answer.trim());
}

/** First branch that actually answered. See NAME_COLUMNS. */
function nameFrom(values: readonly string[]): string {
  for (const column of NAME_COLUMNS) {
    const found = cell(values, column);
    if (found) return found;
  }
  return "";
}

export function parseRow(row: number, values: readonly string[]): ApplicationRow {
  const auditionMethodRaw = cell(values, AUDITION_METHOD_COLUMN);
  return {
    row,
    email: cell(values, PINNED.email),
    applicantType: cell(values, PINNED.applicantType),
    name: nameFrom(values),
    auditionMethodRaw,
    auditionMethod: classifyAuditionMethod(auditionMethodRaw),
    values,
  };
}
