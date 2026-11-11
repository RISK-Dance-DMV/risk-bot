/**
 * Column addressing for the application response sheet.
 *
 * Repeating headers make read-by-name unusable on this sheet (design doc s22), so
 * every field is addressed by column letter. THIS FILE IS THE ONLY PLACE those
 * letters live - if the form changes, change them here and nowhere else.
 */

/** Pinned by the design doc. Verified at job start; a mismatch stops the job. */
export const PINNED = {
  email: "C",
  applicantType: "D",
  name: "E",
} as const;

/**
 * Substring (case-insensitive) each pinned header must contain.
 *
 * MUST CONFIRM against the live form before enabling the flag - these are
 * plausible defaults, not verified values. Reading pronouns as names is exactly
 * the failure the header check exists to prevent.
 */
export const PINNED_HEADER_MATCH: Record<string, string> = {
  C: "email",
  D: "applying",
  E: "name",
};

/**
 * Every column that can hold the applicant's name, in the order to try them.
 *
 * The form branches on applicant type (column D) and asks for a name *after*
 * the branch, so each branch has its own Name question and its own column:
 * E for dancers, W for videographers and editors. Both headers read "Name",
 * which is why the header check can't tell them apart and why this is a list
 * of letters rather than a lookup.
 *
 * If a third branch appears, add its column here — nothing else needs to know.
 */
export const NAME_COLUMNS = ["E", "W"] as const;

export interface CardColumn {
  key: string;
  label: string;
  /** null = not yet configured; renders as "-" and is noted on the card. */
  column: string | null;
  inline?: boolean;
}

/** Fields shown on the dancer card (design doc s22). */
export const CARD_COLUMNS: CardColumn[] = [
  { key: "age", label: "Age", column: "G", inline: true },
  { key: "location", label: "Location", column: "H", inline: true },
  { key: "transportation", label: "Transportation", column: "K", inline: true },
  { key: "subunits", label: "Subunits", column: "I" },
  { key: "availability", label: "Availability", column: "AQ" },
  { key: "feedback", label: "Feedback preference", column: "P", inline: true },
];

/**
 * Video columns. The column itself names the category, so the label comes from
 * here; any annotation inside the cell is kept as a per-link label on top.
 *
 * The form once asked for CREW and SOLO videos separately, in AM/AN and AO/AP.
 * The SOLO questions are gone, so AN and AP are no longer read — but they are
 * still there in the sheet holding the answers people gave before the change,
 * which is why nothing below shifted up.
 */
export interface VideoColumn {
  column: string;
  label: string;
}

export const VIDEO_COLUMNS: VideoColumn[] = [
  { column: "AM", label: "Boy Group" },
  { column: "AO", label: "Girl Group" },
];

/**
 * The audition form's video column — column D on the *audition* response sheet,
 * not the application one. Every other letter in this file addresses the
 * application sheet, so this is the exception worth naming out loud.
 */
export const AUDITION_VIDEO_COLUMN = "D";

export const AUDITION_VIDEO_LABEL = "RISK Audition";

/**
 * "Videography and/or editing submissions" — the videographer branch's answer
 * to what a dancer's video columns ask. Their card is a one-liner, but a
 * one-liner with no work on it is a card nobody can act on.
 */
export const VIDEOGRAPHER_WORK_COLUMN = "AJ";

/** Applicant-type values that get the full card rather than a one-liner. */
export const DANCER_TYPE_MATCH = "dancer";

// ------------------------------------------------------------ audition method

export const AUDITION_METHOD_COLUMN = "AL";

/**
 * "Chosen audition method". Two live values:
 *   - "Existing dance video submission and interview" -> reviewable on arrival
 *   - "RISK Audition process"                         -> waits on a separate
 *     audition form (rank 21), and closes if nothing arrives.
 */
export type AuditionMethod = "video_submission" | "risk_process" | "unknown";

export const AUDITION_METHOD_MATCH: { method: AuditionMethod; pattern: RegExp }[] = [
  { method: "video_submission", pattern: /existing dance video/i },
  { method: "risk_process", pattern: /risk audition process/i },
];

export const AUDITION_METHOD_LABEL: Record<AuditionMethod, string> = {
  video_submission: "Existing dance video + interview",
  risk_process: "RISK audition process",
  unknown: "Unrecognised",
};
