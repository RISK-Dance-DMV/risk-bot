/**
 * Subunits (design doc §3's Subunit column, §12's Hearts/Spades select). Pure.
 *
 * Placement is offered only from what the applicant actually auditioned for -
 * column I on the application form - so nobody gets placed in a subunit they
 * never tried out for.
 */

/**
 * Placements this flow can assign.
 *
 * Diamonds is deliberately absent. It's the competition unit, and you can't
 * audition into it directly — you're placed in Spades or Hearts first and go
 * through a separate comp audition after. An applicant who ticked Diamonds on
 * the form still shows it under Subunits on their card; it just isn't
 * something this decision gets to hand out.
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

/**
 * What each subunit is, for people who don't already know.
 *
 * Only ever used in email. On the card the directors know what Spades is, and
 * spelling it out on every render would be noise.
 */
export const SUBUNIT_GLOSS: Record<Subunit, string> = {
  Spades: "boy group unit",
  Hearts: "girl group unit",
  Clubs: "trainee unit",
};

/** For email: "Spades (boy group unit) and Clubs (trainee unit)". */
export function formatSubunitsLong(units: readonly Subunit[]): string {
  return formatList(units.map((unit) => `${unit} (${SUBUNIT_GLOSS[unit]})`));
}

/** For the card, and anywhere else a director is reading: bare names. */
export function formatSubunits(units: readonly Subunit[]): string {
  return formatList(units as readonly string[]);
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The placement that needs no choosing.
 *
 * Two cases where a director shouldn't have to operate a menu: the vote already
 * agreed one, or the applicant only auditioned for a single subunit so the menu
 * has exactly one entry. Both need a button, because a string select fires only
 * when the selection *changes* — an option that is already ticked can't be
 * re-picked, which leaves the card with no way forward at all.
 */
export function presumedPlacement(
  appliedFor: string,
  seeded?: readonly string[],
): Subunit[] {
  if (seeded && seeded.length > 0) {
    return SUBUNITS.filter((unit) => seeded.includes(unit));
  }
  const { options } = placementOptions(appliedFor);
  return options.length === 1 ? options : [];
}
