/**
 * Decision votes and director feedback (design doc rank 23). Pure.
 *
 * The doc frames this as [Yes] [No], but the real question isn't whether to take
 * someone - it's *which subunits* to take them into, or none. So a ballot is a
 * set of subunits, and an empty set is the "no".
 *
 * Agreement is exact: ballots must match. Hearts and Hearts+Clubs is a split,
 * not a narrower yes. Placement decides which room someone spends their season
 * in, so near-agreement isn't treated as agreement.
 *
 * [Need to discuss] remains a hold, not a vote.
 */
import { escapeMd, mention, truncate } from "./text";

/**
 * The subunits one director voted to accept them into.
 *   []       - accept into none, i.e. a no
 *   "hold"   - [Need to discuss]; blocks settlement without being a vote
 */
export type Ballot = string[] | "hold";

export function isHold(ballot: Ballot | undefined): ballot is "hold" {
  return ballot === "hold";
}

/** Order-insensitive comparison - picking Hearts,Clubs equals Clubs,Hearts. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

export interface FeedbackEntry {
  text: string;
  at: string;
}

/** How a split was settled once the directors had talked it through. */
export interface FinalDecision {
  outcome: "yes" | "no";
  by: string;
  at: string;
}

export interface Decision {
  ballots: Record<string, Ballot>;
  feedback: Record<string, FeedbackEntry>;
  /**
   * Recorded by whichever director presses [Final Yes] / [Final No] after the
   * discussion. Overrides the tally; pressing the other button corrects it.
   */
  final?: FinalDecision;
  /** Set once the split has been announced, so it announces once. */
  pingedDiscussion?: boolean;
  /** Same, for the vote reaching a decision on its own. */
  pingedSettled?: boolean;
}

export function emptyDecision(): Decision {
  return { ballots: {}, feedback: {} };
}

/**
 * Statuses reached by voting. The doc also lists interview-offered,
 * interview-scheduled and waitlisted; those belong to rank 24 and aren't
 * reachable from these buttons.
 */
export type DecisionStatus = "new" | "in-review" | "discussing" | "accepted" | "rejected";

export interface Tally {
  /** How many directors voted for each subunit. */
  bySubunit: Record<string, number>;
  /** Voted to accept into nothing. */
  no: number;
  hold: number;
  /** Votes only - a hold is not a vote. */
  cast: number;
}

export function tally(decision: Decision): Tally {
  const bySubunit: Record<string, number> = {};
  let no = 0;
  let hold = 0;
  let cast = 0;

  for (const ballot of Object.values(decision.ballots)) {
    if (isHold(ballot)) {
      hold++;
      continue;
    }
    cast++;
    if (ballot.length === 0) no++;
    for (const unit of ballot) bySubunit[unit] = (bySubunit[unit] ?? 0) + 1;
  }
  return { bySubunit, no, hold, cast };
}

/** The ballots actually cast, holds excluded. */
function castBallots(decision: Decision): string[][] {
  return Object.values(decision.ballots).filter(
    (b): b is string[] => !isHold(b),
  );
}

/**
 * The placement everyone voted for, or null if they didn't all vote the same.
 *
 * Requires every director to have voted - a set two out of three agree on isn't
 * agreement while the third is still thinking.
 */
export function agreedPlacement(
  decision: Decision,
  directorIds: readonly string[],
): string[] | null {
  if (directorIds.length === 0) return null;

  const ballots: string[][] = [];
  for (const id of directorIds) {
    const ballot = decision.ballots[id];
    if (ballot === undefined || isHold(ballot)) return null;
    ballots.push(ballot);
  }

  const first = ballots[0];
  if (!first) return null;
  return ballots.every((b) => sameSet(b, first)) ? [...first].sort() : null;
}

/**
 * A split. Any difference between cast ballots counts - Hearts versus
 * Hearts+Clubs is a disagreement about placement, not a narrower yes.
 */
export function hasSplit(decision: Decision): boolean {
  const ballots = castBallots(decision);
  if (ballots.length < 2) return false;
  const first = ballots[0];
  if (!first) return false;
  return !ballots.every((b) => sameSet(b, first));
}

export function decisionStatus(
  decision: Decision,
  directorIds: readonly string[],
  minVotes: number,
): DecisionStatus {
  // A recorded final outcome is the answer, whatever the tally says.
  if (decision.final) return decision.final.outcome === "yes" ? "accepted" : "rejected";

  const t = tally(decision);
  if (t.cast === 0 && t.hold === 0) return "new";

  if (hasSplit(decision)) return "discussing";

  // A hold blocks settlement without being a vote.
  if (t.hold > 0) return "in-review";
  if (t.cast < minVotes) return "in-review";

  const agreed = agreedPlacement(decision, directorIds);
  if (agreed === null) return "in-review";
  return agreed.length > 0 ? "accepted" : "rejected";
}

/** Decision buttons are live only in these states. */
export function isSettled(status: DecisionStatus): boolean {
  return status === "accepted" || status === "rejected";
}

export interface FeedbackProgress {
  submitted: number;
  total: number;
  complete: boolean;
}

/**
 * Feedback stays hidden until every director has left some, so nobody is
 * anchored by what was written before them.
 */
export function feedbackProgress(
  decision: Decision,
  directorIds: readonly string[],
): FeedbackProgress {
  const submitted = directorIds.filter((id) => decision.feedback[id]?.text).length;
  return {
    submitted,
    total: directorIds.length,
    complete: directorIds.length > 0 && submitted === directorIds.length,
  };
}

const STATUS_LABEL: Record<DecisionStatus, string> = {
  new: "🗳️ No votes yet",
  "in-review": "🗳️ In review",
  discussing:
    "🗣️ **Discussing** — you didn't all vote the same placement. Talk it through, then one of you records the outcome below.",
  accepted: "✅ **Agreed**",
  rejected: "🚫 **Agreed: no placement**",
};

/** One line per director, so a split shows exactly where it disagrees. */
function ballotLines(decision: Decision, directorIds: readonly string[]): string[] {
  const lines: string[] = [];
  for (const [id, ballot] of Object.entries(decision.ballots)) {
    if (isHold(ballot)) {
      lines.push(`${mention(id)} — 🗣️ needs to discuss`);
    } else if (ballot.length === 0) {
      lines.push(`${mention(id)} — none`);
    } else {
      lines.push(`${mention(id)} — ${[...ballot].sort().join(", ")}`);
    }
  }
  const yetToVote = directorIds.filter((id) => decision.ballots[id] === undefined);
  for (const id of yetToVote) lines.push(`${mention(id)} — *yet to vote*`);
  return lines;
}

/** The decision block shown in the card's description. */
export function renderDecision(
  decision: Decision,
  directorIds: readonly string[],
  minVotes: number,
): string {
  const status = decisionStatus(decision, directorIds, minVotes);
  const t = tally(decision);
  const progress = feedbackProgress(decision, directorIds);

  const lines: string[] = [];
  if (decision.final) {
    const verdict =
      decision.final.outcome === "yes"
        ? "✅ **Moving onto interview**"
        : "🚫 **Rejected from RISK**";
    lines.push(`${verdict} — decided by ${mention(decision.final.by)} after discussion`);
  } else {
    const agreed = agreedPlacement(decision, directorIds);
    lines.push(
      status === "accepted" && agreed?.length
        ? `✅ **Agreed: ${agreed.join(", ")}**`
        : STATUS_LABEL[status],
    );
  }

  if (t.cast + t.hold > 0) {
    const counts = Object.entries(t.bySubunit)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([unit, n]) => `${unit} ${n}`);
    if (t.no > 0) counts.push(`none ${t.no}`);
    if (counts.length > 0) lines.push(counts.join(" · "));
    lines.push(...ballotLines(decision, directorIds));
  }

  if (directorIds.length === 0) {
    lines.push("⚠️ `config:director_ids` isn't set, so votes can't settle.");
  } else if (progress.complete) {
    lines.push(`Feedback: all ${progress.total} in — shown below.`);
  } else {
    lines.push(
      `Feedback: ${progress.submitted} of ${progress.total} in — hidden until everyone has written.`,
    );
  }

  return lines.join("\n");
}

// ------------------------------------------------------------- the outcome

/**
 * The terminal decision, reachable two ways (doc open question 3, answered yes):
 * directly once the vote is unanimous, or after an interview.
 */
export type ApplicationOutcome = "welcomed" | "rejected" | "waitlisted";

export interface OutcomeRecord {
  outcome: ApplicationOutcome;
  by: string;
  at: string;
  /**
   * Placement, for welcomed and waitlisted. Kept on a waitlist record so a
   * "a Spades spot opened" sweep can find the right people rather than everyone.
   */
  subunits?: string[];
  /** Feedback as it was actually sent, composed at outcome time. */
  feedback?: string;
  /** When a waitlisted applicant should resurface for another look. */
  revisitAt?: string;
  /** The draft carrying the email, until it is approved. */
  draftId?: string;
  sentAt?: string;
}

/**
 * A decision part-way through being made: the button is pressed, but placement
 * and feedback are still being collected. Held on the record rather than encoded
 * in a custom_id, which caps at 100 characters.
 */
export interface PendingOutcome {
  outcome: ApplicationOutcome;
  subunits?: string[];
  startedBy: string;
}

export const OUTCOME_LABEL: Record<ApplicationOutcome, string> = {
  welcomed: "WELCOME TO RISK",
  rejected: "Reject from RISK",
  waitlisted: "Waitlist",
};

/** Which of the doc's s27 templates a given outcome uses. */
export function outcomeTemplateKey(
  outcome: ApplicationOutcome,
  wantsFeedback: boolean,
): string {
  if (outcome === "welcomed") return "acceptance";
  if (outcome === "waitlisted") return "waitlist notice";
  return wantsFeedback ? "rejection with feedback" : "rejection without feedback";
}

function unixOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export function renderOutcomeLine(record: OutcomeRecord): string {
  const who = mention(record.by);
  const placement = record.subunits?.length ? ` — **${record.subunits.join(", ")}**` : "";
  const pending = record.sentAt ? " — email sent" : " — ⚠️ drafted, not sent yet";

  switch (record.outcome) {
    case "welcomed":
      return `🎉 **Welcomed into RISK**${placement}, recorded by ${who}${pending}.`;
    case "rejected":
      return `🚫 **Rejected**, recorded by ${who}${pending}.`;
    case "waitlisted": {
      const revisit = record.revisitAt
        ? `\nResurfaces <t:${unixOf(record.revisitAt)}:R> — or sooner if a spot opens.`
        : "";
      return `⏸️ **Waitlisted** for${placement || " a spot"}, recorded by ${who}${pending}.${revisit}`;
    }
  }
}

export interface FeedbackField {
  name: string;
  value: string;
  inline: boolean;
}

// Embeds cap at 6000 chars across all fields; full text always stays in KV.
const FEEDBACK_FIELD_LIMIT = 800;

/** Revealed feedback, one embed field per director. Empty until everyone is in. */
export function feedbackFields(
  decision: Decision,
  directorIds: readonly string[],
  nameFor: (id: string) => string = mention,
): FeedbackField[] {
  if (!feedbackProgress(decision, directorIds).complete) return [];
  return directorIds.map((id) => ({
    name: `Feedback — ${nameFor(id)}`,
    value: truncate(escapeMd(decision.feedback[id]?.text ?? "—"), FEEDBACK_FIELD_LIMIT),
    inline: false,
  }));
}
