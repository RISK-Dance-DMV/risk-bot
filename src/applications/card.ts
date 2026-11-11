/**
 * Card rendering. Pure - takes a row plus already-checked video links and
 * already-recorded votes, and returns a Discord message payload.
 */
import {
  AUDITION_METHOD_LABEL,
  CARD_COLUMNS,
  DANCER_TYPE_MATCH,
  VIDEOGRAPHER_WORK_COLUMN,
} from "../config/columns";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type MessagePayload,
} from "../discord/types";
import {
  decisionStatus,
  feedbackFields,
  hasSplit,
  OUTCOME_LABEL,
  renderDecision,
  renderOutcomeLine,
  type ApplicationOutcome,
  type Decision,
  type DecisionStatus,
  type OutcomeRecord,
  type PendingOutcome,
} from "./decision";
import { placementOptions, presumedPlacement } from "../config/subunits";
import { cell } from "./fields";
import type { ApplicationRow } from "./fields";
import { renderInterviewLine, type InterviewRecord } from "./interviewSlot";
import { escapeMd, truncate } from "./text";
import { countLinks, extractVideoLinks, type VideoGroup } from "./videos";

const EMBED_FIELD_LIMIT = 1024;
const EMBED_DESC_LIMIT = 4096;
const DASH = "—";

const COLOR = {
  open: 0x5865f2,
  awaiting: 0xe67e22,
  submitted: 0x2ecc71,
  closed: 0x747f8d,
} as const;

/**
 * Card lifecycle - the applicant's *material*, not the decision.
 *   open      - existing-video applicant, reviewable now
 *   awaiting  - RISK-process applicant, waiting on the separate audition form
 *   submitted - audition form arrived
 *   closed    - awaited past the deadline with nothing submitted
 */
export type CardState = "open" | "awaiting" | "submitted" | "closed";

/**
 * Decision buttons appear only once there is something to decide on.
 *
 * A RISK-process applicant has submitted nothing yet while `awaiting`, so voting
 * on them would be voting on an empty card. An existing-links applicant arrives
 * complete, so their buttons are live from the first post.
 */
export function isDecidable(state: CardState): boolean {
  return state === "open" || state === "submitted";
}

// ------------------------------------------------------------- custom ids

export type CardAction =
  | "reopen"
  | "vote"
  | "hold"
  | "final-yes"
  | "final-no"
  | "final-placement"
  | "feedback"
  | "feedback-save"
  | "interview"
  | "interview-confirm"
  | "interview-confirm-save"
  | "interview-save"
  | "outcome-welcome"
  | "outcome-reject"
  | "outcome-waitlist"
  | "placement"
  | "placement-confirm"
  | "outcome-save"
  | "reply"
  | "reply-save"
  | "skip-interview";

const ACTIONS: CardAction[] = [
  "reopen",
  "vote",
  "hold",
  "final-yes",
  "final-no",
  "final-placement",
  "feedback",
  "feedback-save",
  "interview",
  "interview-confirm",
  "interview-confirm-save",
  "interview-save",
  "outcome-welcome",
  "outcome-reject",
  "outcome-waitlist",
  "placement",
  "placement-confirm",
  "outcome-save",
  "reply",
  "reply-save",
  "skip-interview",
];

/** Persistent custom_id - the interaction token expires in ~15 min, this does not. */
export function customId(action: CardAction, row: number): string {
  return `app|${action}|${row}`;
}

export function parseCustomId(
  raw: string,
): { action: CardAction; row: number } | null {
  const parts = raw.split("|");
  if (parts.length !== 3 || parts[0] !== "app") return null;
  const action = parts[1] as CardAction;
  if (!ACTIONS.includes(action)) return null;
  const row = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isFinite(row) || row < 2) return null;
  return { action, row };
}

/** Actions gated on the director roster. */
export function isDirectorAction(action: CardAction): boolean {
  return [
    "vote",
    "hold",
    "final-yes",
    "final-no",
    "final-placement",
    "feedback",
    "feedback-save",
    "interview",
    "interview-confirm",
    "interview-confirm-save",
    "interview-save",
    "outcome-welcome",
    "outcome-reject",
    "outcome-waitlist",
    "placement",
    "placement-confirm",
    "outcome-save",
    "reply",
    "reply-save",
    "skip-interview",
  ].includes(action);
}

// -------------------------------------------------------------- rendering

export function isDancer(applicantType: string): boolean {
  return applicantType.toLowerCase().includes(DANCER_TYPE_MATCH);
}

/** Discord renders these in the reader's own timezone. */
function discordDate(at: Date): string {
  const unix = Math.floor(at.getTime() / 1000);
  return `<t:${unix}:D> (<t:${unix}:R>)`;
}

function renderVideoGroups(groups: VideoGroup[]): string {
  return groups
    .map((group) => {
      const lines = group.links.map((link) => {
        const label = link.label ? `${escapeMd(truncate(link.label, 80))} ${DASH} ` : "";
        const flag =
          link.access === "restricted"
            ? " ⚠️ **restricted**"
            : link.access === "unknown"
              ? " ❓ sharing unknown"
              : "";
        return `• ${label}<${link.url}>${flag}`;
      });
      return [`**${group.label}**`, ...lines].join("\n");
    })
    .join("\n\n");
}

/**
 * The audition-method line, and what the absence of videos means.
 *
 * A RISK-process applicant having no videos is expected. A video-submission
 * applicant having none is a problem, and says so.
 */
function renderMethodAndVideos(
  row: ApplicationRow,
  state: CardState,
  groups: VideoGroup[],
  dueAt?: Date,
  outcomeSent = false,
): string {
  const method = AUDITION_METHOD_LABEL[row.auditionMethod];
  const parts: string[] = [];

  if (row.auditionMethod === "unknown") {
    parts.push(
      `**Audition method:** ⚠️ ${method} ${DASH} \`${escapeMd(truncate(row.auditionMethodRaw || "(blank)", 200))}\``,
    );
  } else {
    parts.push(`**Audition method:** ${method}`);
  }

  if (row.auditionMethod === "risk_process") {
    if (state === "awaiting") {
      parts.push(
        dueAt
          ? `⏳ Waiting on their audition form submission — closes ${discordDate(dueAt)}.\nVoting opens once it arrives.`
          : "⏳ Waiting on their audition form submission.\nVoting opens once it arrives.",
      );
    } else if (state === "submitted") {
      parts.push("✅ Audition form submitted.");
    } else if (state === "closed") {
      parts.push(
        outcomeSent
          ? "🔒 **Closed** — the decision went out; nothing further is owed."
          : "🔒 **Closed** — no audition form submission arrived in time.",
      );
    }
  }

  if (countLinks(groups) > 0) {
    parts.push(renderVideoGroups(groups));
  } else if (row.auditionMethod !== "risk_process") {
    parts.push(`⚠️ ${DASH} no video links found`);
  }

  return parts.join("\n\n");
}

export interface CardOptions {
  videos: VideoGroup[];
  state: CardState;
  /** When an `awaiting` card closes, if known. */
  dueAt?: Date;
  /** Deep link to the sheet row, if configured. */
  sheetUrl?: string;
  /** Rendered when the applicant type didn't match a known value. */
  typeWarning?: string;
  decision?: Decision;
  directorIds?: readonly string[];
  minVotes?: number;
  interview?: InterviewRecord;
  outcome?: OutcomeRecord;
  pending?: PendingOutcome;
  /** Someone chose to skip the interview, so the outcome buttons are drawn. */
  outcomesRevealed?: boolean;
}

/**
 * Videographer/editor and other non-dancer roles.
 *
 * Deliberately a dead end: no votes, no interview, no statuses. The card says so
 * out loud, so nobody goes hunting for a workflow that was never built.
 */
/**
 * A videographer's submitted work.
 *
 * Links are listed rather than previewed: several reels unfurling into several
 * embeds turns a list of cards into a wall. Anything that isn't a link is shown
 * as the text they wrote, because "my portfolio is on my IG" is still an answer.
 */
function videographerWork(row: ApplicationRow): string {
  const raw = cell(row.values, VIDEOGRAPHER_WORK_COLUMN);
  if (!raw.trim()) return `${DASH} no submissions on the form`;

  const links = extractVideoLinks(raw);
  if (links.length === 0) return escapeMd(truncate(raw, 400));

  return links
    .map((link) => (link.label ? `• ${escapeMd(link.label)} ${DASH} ${link.url}` : `• ${link.url}`))
    .join("\n");
}

export function buildOneLiner(row: ApplicationRow, sheetUrl?: string): MessagePayload {
  const type = row.applicantType || "unspecified";
  const name = row.name || `(no name, row ${row.row})`;

  const buttons: Button[] = [
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.PRIMARY,
      label: "Draft a reply",
      custom_id: customId("reply", row.row),
    },
  ];
  if (sheetUrl) {
    buttons.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.LINK,
      label: "Sheet row",
      url: sheetUrl,
    });
  }

  return {
    content: [
      `\u{1F4F9} **${escapeMd(name)}** ${DASH} ${escapeMd(type)} · row ${row.row}`,
      "**Videography / editing submissions**",
      videographerWork(row),
      "_Sorry, no pre-filled text and workflows. Gotta do this one manually! Feel free to draft a reply~_",
    ].join("\n"),
    allowed_mentions: { parse: [] },
    flags: MessageFlags.SUPPRESS_EMBEDS,
    components: [{ type: ComponentType.ACTION_ROW, components: buttons }],
  };
}

interface Button {
  type: number;
  style: number;
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

interface Select {
  type: number;
  custom_id: string;
  placeholder: string;
  min_values: number;
  max_values: number;
  disabled?: boolean;
  options: { label: string; value: string; default?: boolean }[];
}

/** Chosen instead of any subunit — an explicit no rather than an empty pick. */
export const VOTE_NONE = "__none__";

/**
 * The ballot: which subunits this director would take them into.
 *
 * A select rather than Yes/No, because the real question was never whether to
 * accept someone — it's where they'd go. Options come from what they auditioned
 * for, plus an explicit "none".
 */
function voteRow(row: number, appliedFor: string, locked: boolean): Select[] {
  const { options } = placementOptions(appliedFor);
  return [
    {
      type: ComponentType.STRING_SELECT,
      custom_id: customId("vote", row),
      placeholder: locked
        ? "Voting locked — settle the split below"
        : "Your vote: which subunits?",
      min_values: 1,
      max_values: options.length + 1,
      disabled: locked,
      options: [
        ...options.map((unit) => ({ label: unit, value: unit })),
        { label: "None — don't accept", value: VOTE_NONE },
      ],
    },
  ];
}

type RowComponent = Button | Select;

/**
 * The placement select, shown while an outcome is part-way through being made.
 *
 * Options come from what they actually auditioned for (column I), so nobody can
 * be placed in a subunit they never tried out for. A rejection needs no
 * placement, so it skips straight to the feedback modal.
 */
function placementRow(
  row: number,
  appliedFor: string,
  pending?: PendingOutcome,
): Select[] {
  if (!pending || pending.outcome === "rejected") return [];

  const { options } = placementOptions(appliedFor);
  const verb = pending.outcome === "welcomed" ? "Placing in" : "Offering";
  // Seeded from what the vote agreed on, so confirming an unchanged placement is
  // one tap. After a split there's nothing agreed, and nothing is preselected.
  const seeded = pending.subunits ?? [];

  return [
    {
      type: ComponentType.STRING_SELECT,
      custom_id: customId("placement", row),
      placeholder: `${verb}… pick one or more`,
      min_values: 1,
      max_values: options.length,
      options: options.map((unit) => ({
        label: unit,
        value: unit,
        ...(seeded.includes(unit) ? { default: true } : {}),
      })),
    },
  ];
}

/**
 * The select alone can't confirm a pre-filled placement.
 *
 * A string select only fires when the selection *changes*, so seeding it from
 * the agreed vote left the one case it was meant to make easy - keep what
 * everyone voted for - with no way to proceed at all. Re-clicking the
 * highlighted option deselects it. This button is the "yes, that" the select
 * can't offer.
 */
function placementConfirmRow(
  row: number,
  appliedFor: string,
  pending?: PendingOutcome,
): Button[] {
  const seeded = presumedPlacement(appliedFor, pending?.subunits);
  if (seeded.length === 0) return [];
  return [
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.SUCCESS,
      label: `Confirm ${seeded.join(" + ")}`,
      custom_id: customId("placement-confirm", row),
    },
  ];
}

/**
 * There is no [Need to discuss] button.
 *
 * A discrepancy already locks the ballot, pings every director and offers the
 * two resolution buttons, so a hold would have signalled something the card had
 * already said. The ballot type survives in the model for records that carry
 * one; nothing sets it any more.
 */
function decisionRow(row: number): Button[] {
  return [
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.PRIMARY,
      label: "Leave feedback",
      custom_id: customId("feedback", row),
    },
  ];
}

/**
 * Shown once the vote splits. The directors talk it through wherever they talk,
 * and one of them records where it landed.
 *
 * Labelled by what happens next rather than by which way the vote went - "Final
 * No" read like a conclusion when it was only a tally, and left cards sitting
 * decided but with the applicant never told.
 *
 * Disappears once the split is resolved: from then on the outcome row carries
 * the decision, so there is exactly one Reject button on the card.
 */
function splitUnresolved(decision: Decision, outcome?: OutcomeRecord): boolean {
  return hasSplit(decision) && !decision.final && !outcome;
}

/**
 * After a discussion, the placement itself.
 *
 * The old [Move onto Interview] button recorded that they'd agreed without
 * recording what on — and the ballots can't supply it, because they're the
 * disagreement. So the yes side of a split is a placement, not a button.
 */
function finalPlacementRow(
  row: number,
  decision: Decision,
  appliedFor: string,
  outcome?: OutcomeRecord,
): Select[] {
  if (!splitUnresolved(decision, outcome)) return [];

  const { options } = placementOptions(appliedFor);
  return [
    {
      type: ComponentType.STRING_SELECT,
      custom_id: customId("final-placement", row),
      placeholder: "Decided: place them in…",
      min_values: 1,
      max_values: options.length,
      options: options.map((unit) => ({ label: unit, value: unit })),
    },
  ];
}

/** The other half of the split: no placement at all. */
function finalRow(row: number, decision: Decision, outcome?: OutcomeRecord): Button[] {
  if (!splitUnresolved(decision, outcome)) return [];
  return [
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.DANGER,
      label: "Reject from RISK",
      custom_id: customId("final-no", row),
    },
  ];
}

/**
 * The terminal step, reachable two ways: directly once the vote is unanimous, or
 * after an interview. Both land on the same three buttons, so an application ends
 * in one place rather than two competing ones.
 *
 * They stay visible after an outcome is recorded, so a misclick is corrected by
 * pressing another — same idea as [Final Yes] / [Final No].
 */
function outcomesReachable(
  status: DecisionStatus,
  interview?: InterviewRecord,
  outcome?: OutcomeRecord,
): boolean {
  return (
    !!outcome ||
    status === "accepted" ||
    status === "rejected" ||
    interview?.state === "scheduled"
  );
}

/**
 * Whether the three outcome buttons are actually drawn.
 *
 * On a freshly accepted card they aren't: the interview is the expected next
 * step, and putting four more buttons beside it makes the card a wall of
 * choices rather than one. They appear once someone says they're skipping the
 * interview, once an interview is scheduled, or once an outcome exists.
 *
 * A rejected card never had an interview to skip, so it gets them straight away.
 */
function outcomesShown(
  status: DecisionStatus,
  interview?: InterviewRecord,
  outcome?: OutcomeRecord,
  revealed?: boolean,
): boolean {
  if (!outcomesReachable(status, interview, outcome)) return false;
  return (
    !!outcome ||
    !!revealed ||
    status === "rejected" ||
    interview?.state === "scheduled"
  );
}

function outcomeRow(
  row: number,
  status: DecisionStatus,
  interview?: InterviewRecord,
  outcome?: OutcomeRecord,
): Button[] {
  if (!outcomesReachable(status, interview, outcome)) return [];

  // A unanimous no shouldn't put a welcome button under someone's thumb.
  const available: ApplicationOutcome[] =
    status === "rejected" && !outcome && interview?.state !== "scheduled"
      ? ["rejected", "waitlisted"]
      : ["welcomed", "rejected", "waitlisted"];

  const chosenStyle: Record<ApplicationOutcome, number> = {
    welcomed: ButtonStyle.SUCCESS,
    rejected: ButtonStyle.DANGER,
    waitlisted: ButtonStyle.PRIMARY,
  };
  const action: Record<ApplicationOutcome, CardAction> = {
    welcomed: "outcome-welcome",
    rejected: "outcome-reject",
    waitlisted: "outcome-waitlist",
  };

  return available.map((value) => ({
    type: ComponentType.BUTTON,
    style: outcome?.outcome === value ? chosenStyle[value] : ButtonStyle.SECONDARY,
    label: OUTCOME_LABEL[value],
    custom_id: customId(action[value], row),
  }));
}

/**
 * [Interview] drafts or redrafts the invitation; [Interview Confirmed] appears
 * only once one has actually gone out, since there is nothing to confirm before
 * then.
 */
function interviewRow(
  row: number,
  status: DecisionStatus,
  interview?: InterviewRecord,
  outcome?: OutcomeRecord,
  outcomesVisible?: boolean,
): Button[] {
  // Interviews are for applicants the directors agreed to interview. A rejected,
  // undecided, or already-finished card offers nothing here.
  if (status !== "accepted" || outcome) return [];

  const buttons: Button[] = [];
  if (interview?.state !== "scheduled") {
    buttons.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.PRIMARY,
      label: interview ? "Redraft interview" : "Interview",
      custom_id: customId("interview", row),
    });
  }
  if (interview?.state === "offered") {
    buttons.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.SUCCESS,
      label: "Interview Confirmed",
      custom_id: customId("interview-confirm", row),
    });
  }

  // The way past the interview, for someone you've seen enough of. One button
  // instead of three, until it's actually the decision being made.
  if (!outcomesVisible) {
    buttons.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.SECONDARY,
      label: "Skip interview — jump to results",
      custom_id: customId("skip-interview", row),
    });
  }
  return buttons;
}

export function buildDancerCard(row: ApplicationRow, opts: CardOptions): MessagePayload {
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  const unconfigured: string[] = [];

  for (const col of CARD_COLUMNS) {
    if (!col.column) {
      unconfigured.push(col.label);
      continue;
    }
    const value = cell(row.values, col.column);
    fields.push({
      name: col.label,
      value: truncate(value || DASH, EMBED_FIELD_LIMIT),
      inline: col.inline ?? false,
    });
  }

  const decision = opts.decision;
  const directorIds = opts.directorIds ?? [];
  const minVotes = opts.minVotes ?? 2;
  const decidable = isDecidable(opts.state);
  const status: DecisionStatus = decision
    ? decisionStatus(decision, directorIds, minVotes)
    : "new";

  const blocks: string[] = [
    renderMethodAndVideos(
      row,
      opts.state,
      opts.videos,
      opts.dueAt,
      !!opts.outcome?.sentAt,
    ),
  ];
  // Still shown on a card closed by its outcome - that interview is part of
  // the record, and hiding it would make the card read as if it never happened.
  if (opts.interview && (decidable || opts.outcome)) {
    blocks.push(renderInterviewLine(opts.interview));
  }
  if (opts.outcome) blocks.push(renderOutcomeLine(opts.outcome));
  if (decision && decidable) {
    blocks.push(renderDecision(decision, directorIds, minVotes));
    fields.push(...feedbackFields(decision, directorIds));
  }

  if (opts.typeWarning) blocks.push(`⚠️ ${opts.typeWarning}`);
  if (unconfigured.length > 0) {
    blocks.push(`⚠️ Not configured in columns.ts: ${unconfigured.join(", ")}`);
  }

  const subunitsColumn = CARD_COLUMNS.find((c) => c.key === "subunits")?.column ?? null;
  const placement = placementRow(row.row, cell(row.values, subunitsColumn), opts.pending);
  if (placement.length > 0) {
    blocks.push(
      opts.pending?.subunits?.length
        ? `⏳ **Waiting on placement** — confirm what the vote agreed, or pick different ones below.`
        : `⏳ **Waiting on placement** — pick below, then write the feedback that goes in the email.`,
    );
  }

  const rows: RowComponent[][] = [];

  // Mid-decision the card shows only what's being asked for. Everything else is
  // hidden, which also keeps the whole card inside Discord's five action rows.
  if (placement.length > 0) {
    rows.push(placement);
    const confirm = placementConfirmRow(
      row.row,
      cell(row.values, subunitsColumn),
      opts.pending,
    );
    if (confirm.length > 0) rows.push(confirm);
  } else {
    if (decision && decidable) {
      rows.push(voteRow(row.row, cell(row.values, subunitsColumn), hasSplit(decision)));
      rows.push(decisionRow(row.row));
      const decided = finalPlacementRow(
        row.row,
        decision,
        cell(row.values, subunitsColumn),
        opts.outcome,
      );
      if (decided.length > 0) rows.push(decided);
      const final = finalRow(row.row, decision, opts.outcome);
      if (final.length > 0) rows.push(final);
    }
    if (decidable) {
      const showOutcomes = outcomesShown(
        status,
        opts.interview,
        opts.outcome,
        opts.outcomesRevealed,
      );

      const interview = interviewRow(
        row.row,
        status,
        opts.interview,
        opts.outcome,
        showOutcomes,
      );
      if (interview.length > 0) rows.push(interview);

      if (showOutcomes) {
        const outcome = outcomeRow(row.row, status, opts.interview, opts.outcome);
        if (outcome.length > 0) rows.push(outcome);
      }
    }
  }

  const utility: Button[] = [];
  if (opts.state === "closed") {
    utility.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.PRIMARY,
      label: "Reopen",
      custom_id: customId("reopen", row.row),
    });
  }
  // [Sheet row] over an in-Discord row dump: it shows the whole answer without
  // truncation, it's a link so it can't fail or time out, and the sheet is the
  // source of truth anyway.
  if (opts.sheetUrl) {
    utility.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.LINK,
      label: "Sheet row",
      url: opts.sheetUrl,
    });
  }
  if (utility.length > 0) rows.push(utility);

  const interviewStatus = opts.interview ? ` · interview-${opts.interview.state}` : "";
  const outcomeStatus = opts.outcome ? ` · ${opts.outcome.outcome}` : "";
  const footerStatus = decidable
    ? `${opts.state} · ${status}${interviewStatus}${outcomeStatus}`
    : opts.state;

  return {
    embeds: [
      {
        title: truncate(row.name || `(no name, row ${row.row})`, 256),
        description: truncate(blocks.join("\n\n"), EMBED_DESC_LIMIT),
        color: COLOR[opts.state],
        fields,
        footer: {
          text: `row ${row.row} · ${row.applicantType || "type unspecified"} · ${footerStatus}`,
        },
      },
    ],
    // Discord allows five action rows; decision + final + interview + outcome
    // + utility is exactly five in the worst case.
    components: rows.slice(0, 5).map((components) => ({
      type: ComponentType.ACTION_ROW,
      components,
    })),
    allowed_mentions: { parse: [] },
  };
}

/**
 * Routes a row to its message shape.
 *
 * A type we don't recognise gets the *full* card with a warning, not a one-liner:
 * under-surfacing an applicant is the worse failure.
 */
export function buildIntakeMessage(
  row: ApplicationRow,
  opts: CardOptions,
): MessagePayload {
  if (isDancer(row.applicantType)) return buildDancerCard(row, opts);

  const known = /videograph|editor|photograph|media/i.test(row.applicantType);
  if (known) return buildOneLiner(row, opts.sheetUrl);

  return buildDancerCard(row, {
    ...opts,
    typeWarning: `Unrecognised applicant type "${row.applicantType || "(blank)"}" — shown in full so it isn't missed.`,
  });
}

