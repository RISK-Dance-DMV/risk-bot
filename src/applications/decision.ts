/**
 * Decision votes and director feedback (design doc rank 23). Pure.
 *
 *   [Yes] [No] [Need to discuss] - each click recorded, tally on the card.
 *   [Need to discuss] is a hold, not a vote.
 *   Split votes flip the card to a discussion state.
 *   Unanimous Yes unlocks [Send acceptance].
 *
 * "Unanimous among whom?" is the doc's own open question 3. This implements its
 * suggested default: every director has balloted, at least `minVotes` of them,
 * and no hold outstanding.
 */
import { escapeMd, mention, truncate } from "./text";

export type Ballot = "yes" | "no" | "hold";

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
  yes: number;
  no: number;
  hold: number;
  /** Votes only - a hold is not a vote. */
  cast: number;
}

export function tally(decision: Decision): Tally {
  let yes = 0;
  let no = 0;
  let hold = 0;
  for (const ballot of Object.values(decision.ballots)) {
    if (ballot === "yes") yes++;
    else if (ballot === "no") no++;
    else hold++;
  }
  return { yes, no, hold, cast: yes + no };
}

/**
 * A split vote. Locks the Yes/No/Discuss buttons (design doc s23) and puts the
 * [Final Yes] / [Final No] pair on the card.
 */
export function hasSplit(decision: Decision): boolean {
  const t = tally(decision);
  return t.yes > 0 && t.no > 0;
}

export function decisionStatus(
  decision: Decision,
  directorIds: readonly string[],
  minVotes: number,
): DecisionStatus {
  // A recorded final outcome is the answer, whatever the tally says.
  if (decision.final) return decision.final.outcome === "yes" ? "accepted" : "rejected";

  const t = tally(decision);
  if (t.yes === 0 && t.no === 0 && t.hold === 0) return "new";

  if (hasSplit(decision)) return "discussing";

  // A hold blocks settlement without being a vote.
  if (t.hold > 0) return "in-review";
  if (directorIds.length === 0) return "in-review";

  const allBalloted = directorIds.every((id) => {
    const ballot = decision.ballots[id];
    return ballot === "yes" || ballot === "no";
  });
  if (!allBalloted || t.cast < minVotes) return "in-review";

  if (t.no === 0) return "accepted";
  if (t.yes === 0) return "rejected";
  return "in-review";
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
    "🗣️ **Discussing** — split vote. Talk it through, then one of you records the outcome below.",
  accepted: "✅ **Unanimous yes**",
  rejected: "🚫 **Unanimous no**",
};

function ballotLine(decision: Decision, ballot: Ballot): string[] {
  const ids = Object.entries(decision.ballots)
    .filter(([, value]) => value === ballot)
    .map(([id]) => mention(id));
  return ids.length > 0 ? [ids.join(" ")] : [];
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
    const verdict = decision.final.outcome === "yes" ? "✅ **Final: yes**" : "🚫 **Final: no**";
    lines.push(`${verdict} — recorded by ${mention(decision.final.by)} after discussion`);
  } else {
    lines.push(STATUS_LABEL[status]);
  }

  if (t.yes + t.no + t.hold > 0) {
    lines.push(`Yes ${t.yes} · No ${t.no} · Discuss ${t.hold}`);
    for (const [label, ballot] of [
      ["Yes", "yes"],
      ["No", "no"],
      ["Discuss", "hold"],
    ] as const) {
      for (const who of ballotLine(decision, ballot)) lines.push(`${label}: ${who}`);
    }
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
  /** The draft carrying the email, until it is approved. */
  draftId?: string;
  sentAt?: string;
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

export function renderOutcomeLine(record: OutcomeRecord): string {
  const who = mention(record.by);
  switch (record.outcome) {
    case "welcomed":
      return record.sentAt
        ? `🎉 **Welcomed into RISK** — acceptance sent, recorded by ${who}.`
        : `🎉 **Welcomed into RISK** by ${who} — ⚠️ acceptance drafted, not sent yet.`;
    case "rejected":
      return record.sentAt
        ? `🚫 **Rejected** — notice sent, recorded by ${who}.`
        : `🚫 **Rejected** by ${who} — ⚠️ notice drafted, not sent yet.`;
    case "waitlisted":
      return record.sentAt
        ? `⏸️ **Waitlisted** — notice sent, recorded by ${who}.`
        : `⏸️ **Waitlisted** by ${who} — ⚠️ notice drafted, not sent yet.`;
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
