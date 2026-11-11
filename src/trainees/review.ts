/**
 * Deciding a trainee audition (design doc rank 12). Pure.
 *
 * Reuses the applicant decision model wholesale: a ballot is the subunit(s) to
 * place them in, and an empty ballot is "did not pass". The one thing that
 * differs is the settle rule.
 *
 * An applicant needs every director. A trainee needs `trainee_min_votes` of
 * them — two of three by default — because a director who coaches the trainee
 * shouldn't be voting on their audition, and requiring a vote that will never
 * come would stall every trainee that director works with.
 */
import {
  agreedAmongVoters,
  castBallots,
  hasSplit,
  isHold,
  tally,
  type Decision,
} from "../applications/decision";
import { mention } from "../applications/text";

export type ReviewStatus = "new" | "in-review" | "discussing" | "passed" | "failed";

export function reviewStatus(decision: Decision, minVotes: number): ReviewStatus {
  // A recorded outcome is the answer, whatever the tally says.
  if (decision.final) return decision.final.outcome === "yes" ? "passed" : "failed";

  const t = tally(decision);
  if (t.cast === 0 && t.hold === 0) return "new";
  if (hasSplit(decision)) return "discussing";
  if (t.hold > 0) return "in-review";

  const agreed = agreedAmongVoters(decision, minVotes);
  if (agreed === null) return "in-review";
  return agreed.length > 0 ? "passed" : "failed";
}

export function isReviewSettled(status: ReviewStatus): boolean {
  return status === "passed" || status === "failed";
}

/**
 * The placement that stands, however it was reached — the settled discussion
 * first, then what the voters agreed.
 */
export function reviewPlacement(decision: Decision, minVotes: number): string[] | null {
  if (decision.final) {
    if (decision.final.outcome === "no") return [];
    return decision.final.subunits ?? agreedAmongVoters(decision, minVotes);
  }
  return agreedAmongVoters(decision, minVotes);
}

/**
 * Feedback stays sealed until the decision is settled, rather than until every
 * director has written.
 *
 * Same purpose as the applicant rule — nobody anchored by what was written
 * before them — but tied to the thing that actually ends here. A director who
 * is sitting this one out is never going to write, and holding the others'
 * words hostage to that would mean the trainee never hears any of it.
 */
export function feedbackRevealed(decision: Decision, minVotes: number): boolean {
  return isReviewSettled(reviewStatus(decision, minVotes));
}

/** Notes from whoever wrote them, in roster order, for the trainee's DM. */
export function composeFeedback(
  decision: Decision,
  directorIds: readonly string[],
): string {
  return directorIds
    .map((id) => decision.feedback[id]?.text.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

const STATUS_LABEL: Record<ReviewStatus, string> = {
  new: "🗳️ No votes yet",
  "in-review": "🗳️ In review",
  discussing:
    "🗣️ **Discussing** — you didn't all vote the same. Talk it through, then record it below.",
  passed: "✅ **Passed**",
  failed: "🚫 **Did not pass**",
};

/** The decision block on the review card. */
export function renderReview(
  decision: Decision,
  directorIds: readonly string[],
  minVotes: number,
): string {
  const status = reviewStatus(decision, minVotes);
  const lines: string[] = [];

  if (decision.final) {
    const placed = decision.final.subunits ?? [];
    lines.push(
      decision.final.outcome === "yes"
        ? placed.length > 0
          ? `✅ **Passed — ${placed.join(", ")}**, decided by ${mention(decision.final.by)} after discussion`
          : `✅ **Passed**, decided by ${mention(decision.final.by)} after discussion`
        : `🚫 **Did not pass** — decided by ${mention(decision.final.by)} after discussion`,
    );
  } else {
    const agreed = reviewPlacement(decision, minVotes);
    lines.push(
      status === "passed" && agreed?.length
        ? `✅ **Passed — ${agreed.join(", ")}**`
        : STATUS_LABEL[status],
    );
  }

  const voted = Object.keys(decision.ballots).length;
  const enough = voted >= minVotes;

  // Sealed until enough have voted, for the same reason the applicant ballots
  // are: a visible tally tells the next voter what to say.
  if (enough) {
    const t = tally(decision);
    const counts = Object.entries(t.bySubunit)
      .map(([unit, n]) => `${unit} ${n}`)
      .join(" · ");
    if (counts) lines.push(counts);
    if (t.no > 0) lines.push(`no placement ${t.no}`);

    for (const [id, ballot] of Object.entries(decision.ballots)) {
      if (isHold(ballot)) lines.push(`${mention(id)} — 🗣️ needs to discuss`);
      else if (ballot.length === 0) lines.push(`${mention(id)} — did not pass`);
      else lines.push(`${mention(id)} — ${[...ballot].sort().join(", ")}`);
    }
  } else {
    lines.push(
      `Votes: ${voted} of ${minVotes} needed — sealed until enough are in.`,
    );
  }

  const written = directorIds.filter((id) => decision.feedback[id]?.text);
  lines.push(
    feedbackRevealed(decision, minVotes)
      ? `Feedback: ${written.length} written — shown below, and sent to them when you record the result.`
      : `Feedback: ${written.length} in${
          written.length > 0 ? ` (${written.map(mention).join(", ")})` : ""
        } — text hidden until the vote settles.`,
  );

  return lines.join("\n");
}

export interface ReviewField {
  name: string;
  value: string;
  inline: boolean;
}

export function reviewFeedbackFields(
  decision: Decision,
  directorIds: readonly string[],
  minVotes: number,
): ReviewField[] {
  if (!feedbackRevealed(decision, minVotes)) return [];
  return directorIds
    .filter((id) => decision.feedback[id]?.text)
    .map((id) => ({
      name: `Feedback — ${mention(id)}`,
      value: (decision.feedback[id]?.text ?? "").slice(0, 1024),
      inline: false,
    }));
}

/** True once enough directors have voted that the card can stop asking. */
export function enoughVotes(decision: Decision, minVotes: number): boolean {
  return castBallots(decision).length >= minVotes;
}

/**
 * The exact DM a trainee receives with their result.
 *
 * Pure, and the single source for both the preview a director reads and the
 * message that actually goes out — if these were built separately they would
 * eventually disagree, and the preview would be a lie.
 */
export function resultMessage(
  targetSubunit: string,
  placed: readonly string[],
  feedback: string,
): string {
  const notes = feedback.trim()
    ? `\n\nHere is the feedback they left you:\n\n${feedback.trim()}`
    : "";

  if (placed.length > 0) {
    return (
      "🎉 Hi there! The directors have reviewed your audition and are happy to announce " +
      `that you passed your audition — welcome to ${placed.join(" and ")}. Your role is set.` +
      notes
    );
  }

  return (
    "Hi there! The directors have reviewed your audition and determined that your " +
    `${targetSubunit} audition didn't pass this time.` +
    notes +
    "\n\nFeel free to discuss with your coaches for next steps. You got this!"
  );
}
