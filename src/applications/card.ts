/**
 * Card rendering. Pure - takes a row plus already-checked video links and
 * already-recorded votes, and returns a Discord message payload.
 */
import {
  AUDITION_METHOD_LABEL,
  CARD_COLUMNS,
  DANCER_TYPE_MATCH,
} from "../config/columns";
import { ButtonStyle, ComponentType, type MessagePayload } from "../discord/types";
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
import { placementOptions } from "../config/subunits";
import { cell } from "./fields";
import type { ApplicationRow } from "./fields";
import { renderInterviewLine, type InterviewRecord } from "./interviewSlot";
import { escapeMd, truncate } from "./text";
import { countLinks, type VideoGroup } from "./videos";

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
  | "open"
  | "reopen"
  | "vote"
  | "hold"
  | "final-yes"
  | "final-no"
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
  | "outcome-save"
  | "reply"
  | "reply-save";

const ACTIONS: CardAction[] = [
  "open",
  "reopen",
  "vote",
  "hold",
  "final-yes",
  "final-no",
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
  "outcome-save",
  "reply",
  "reply-save",
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
    "outcome-save",
    "reply",
    "reply-save",
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
      parts.push("🔒 **Closed** — no audition form submission arrived in time.");
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
}

/**
 * Videographer/editor and other non-dancer roles.
 *
 * Deliberately a dead end: no votes, no interview, no statuses. The card says so
 * out loud, so nobody goes hunting for a workflow that was never built.
 */
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
      "_Reply and that's it — no review, no interview._",
    ].join("\n"),
    allowed_mentions: { parse: [] },
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
function finalRow(row: number, decision: Decision, outcome?: OutcomeRecord): Button[] {
  if (!hasSplit(decision) || decision.final || outcome) return [];
  return [
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.SUCCESS,
      label: "Move onto Interview",
      custom_id: customId("final-yes", row),
    },
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
function outcomeRow(
  row: number,
  status: DecisionStatus,
  interview?: InterviewRecord,
  outcome?: OutcomeRecord,
): Button[] {
  const reachable =
    !!outcome ||
    status === "accepted" ||
    status === "rejected" ||
    interview?.state === "scheduled";
  if (!reachable) return [];

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
): Button[] {
  // Interviews are for applicants the directors agreed to interview. A rejected,
  // undecided, or already-finished card offers nothing here.
  if (status !== "accepted" || outcome) return [];

  const buttons: Button[] = [];
  if (interview?.state !== "scheduled") {
    buttons.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.SECONDARY,
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

  const blocks: string[] = [renderMethodAndVideos(row, opts.state, opts.videos, opts.dueAt)];
  if (opts.interview && decidable) blocks.push(renderInterviewLine(opts.interview));
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
      `⏳ **Waiting on placement** — pick below, then write the feedback that goes in the email.`,
    );
  }

  const rows: RowComponent[][] = [];

  // Mid-decision the card shows only what's being asked for. Everything else is
  // hidden, which also keeps the whole card inside Discord's five action rows.
  if (placement.length > 0) {
    rows.push(placement);
  } else {
    if (decision && decidable) {
      rows.push(voteRow(row.row, cell(row.values, subunitsColumn), hasSplit(decision)));
      rows.push(decisionRow(row.row));
      const final = finalRow(row.row, decision, opts.outcome);
      if (final.length > 0) rows.push(final);
    }
    if (decidable) {
      const interview = interviewRow(row.row, status, opts.interview, opts.outcome);
      if (interview.length > 0) rows.push(interview);

      const outcome = outcomeRow(row.row, status, opts.interview, opts.outcome);
      if (outcome.length > 0) rows.push(outcome);
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
  utility.push({
    type: ComponentType.BUTTON,
    style: ButtonStyle.SECONDARY,
    label: "Open row",
    custom_id: customId("open", row.row),
  });
  if (opts.sheetUrl) {
    utility.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.LINK,
      label: "Sheet row",
      url: opts.sheetUrl,
    });
  }
  rows.push(utility);

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

/** Ephemeral full-row dump behind [Open row]. */
export function buildOpenRowResponse(
  row: number,
  headers: readonly string[],
  values: readonly string[],
  sheetUrl?: string,
): MessagePayload {
  const lines: string[] = [];
  let omitted = 0;

  for (let i = 0; i < headers.length; i++) {
    const header = (headers[i] ?? "").toString().trim();
    const value = (values[i] ?? "").toString().trim();
    if (!value) continue;
    const line = `**${escapeMd(truncate(header || `col ${i + 1}`, 120))}**\n${escapeMd(truncate(value, 500))}`;
    if (lines.join("\n\n").length + line.length > EMBED_DESC_LIMIT - 200) {
      omitted++;
      continue;
    }
    lines.push(line);
  }

  const tail: string[] = [];
  if (omitted > 0) tail.push(`_${omitted} field(s) too long to show._`);
  if (sheetUrl) tail.push(`[Open in the sheet](${sheetUrl})`);

  return {
    embeds: [
      {
        title: `Row ${row}`,
        description: truncate(
          [...lines, ...tail].join("\n\n") || "_Row is empty._",
          EMBED_DESC_LIMIT,
        ),
      },
    ],
  };
}
