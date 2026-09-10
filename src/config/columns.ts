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
 */
export interface VideoColumn {
  column: string;
  label: string;
}

export const VIDEO_COLUMNS: VideoColumn[] = [
  { column: "AM", label: "Boy Group — CREW" },
  { column: "AN", label: "Boy Group — SOLO" },
  { column: "AO", label: "Girl Group — CREW" },
  { column: "AP", label: "Girl Group — SOLO" },
];

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
