/**
 * Subunits (design doc §3's Subunit column, §12's Hearts/Spades select). Pure.
 *
 * Placement is offered only from what the applicant actually auditioned for -
 * column I on the application form - so nobody gets placed in a subunit they
 * never tried out for.
 */

export const SUBUNITS = ["Spades", "Hearts", "Clubs"] as const;

export type Subunit = (typeof SUBUNITS)[number];

/**
 * Reads the applicant's answer, which is free text from a checkbox question and
 * arrives in whatever shape the form produced - "Hearts, Spades",
 * "Hearts and Clubs", "hearts/spades".
 *
 * Matched on word boundaries so "Hearts" in a sentence still counts, and order
 * follows SUBUNITS rather than the answer, so the select is always consistent.
 */
export function subunitsAppliedFor(answer: string): Subunit[] {
  const text = (answer ?? "").toLowerCase();
  return SUBUNITS.filter((unit) =>
    new RegExp(`\\b${unit.toLowerCase()}\\b`).test(text),
  );
}

/**
 * What to offer in the placement select.
 *
 * An unreadable answer falls back to all three rather than blocking the
 * decision - a director looking at the card can see what they wrote, and being
 * unable to accept someone because a form answer was odd is the worse failure.
 */
export interface PlacementOptions {
  options: Subunit[];
  /** True when the applicant's answer didn't name any known subunit. */
  fellBack: boolean;
}

export function placementOptions(answer: string): PlacementOptions {
  const applied = subunitsAppliedFor(answer);
  return applied.length > 0
    ? { options: applied, fellBack: false }
    : { options: [...SUBUNITS], fellBack: true };
}

export function formatSubunits(units: readonly Subunit[]): string {
  if (units.length === 0) return "";
  if (units.length === 1) return units[0] as string;
  return `${units.slice(0, -1).join(", ")} and ${units[units.length - 1]}`;
}
