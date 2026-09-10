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
  isSettled,
  renderDecision,
  type Decision,
  type DecisionStatus,
} from "./decision";
import { cell } from "./fields";
import type { ApplicationRow } from "./fields";
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
  | "yes"
  | "no"
  | "hold"
  | "final-yes"
  | "final-no"
  | "feedback"
  | "feedback-save";

const ACTIONS: CardAction[] = [
  "open",
  "reopen",
  "yes",
  "no",
  "hold",
  "final-yes",
  "final-no",
  "feedback",
  "feedback-save",
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

/** Decision actions are the ones gated on the director roster. */
export function isDecisionAction(action: CardAction): boolean {
  return [
    "yes",
    "no",
    "hold",
    "final-yes",
    "final-no",
    "feedback",
    "feedback-save",
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
}

/** Videographer/editor and other non-dancer roles. */
export function buildOneLiner(row: ApplicationRow): MessagePayload {
  const type = row.applicantType || "unspecified";
  const name = row.name || `(no name, row ${row.row})`;
  return {
    content: `\u{1F4F9} **${escapeMd(name)}** ${DASH} ${escapeMd(type)} · row ${row.row}`,
    allowed_mentions: { parse: [] },
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

function decisionRow(row: number, decision: Decision): Button[] {
  // Split votes lock the decision buttons (design doc s23). The way back out is
  // a recorded outcome, not an undo - see finalRow.
  const locked = hasSplit(decision);

  const buttons: Button[] = [
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.SUCCESS,
      label: "Yes",
      custom_id: customId("yes", row),
      disabled: locked,
    },
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.DANGER,
      label: "No",
      custom_id: customId("no", row),
      disabled: locked,
    },
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.SECONDARY,
      label: "Need to discuss",
      custom_id: customId("hold", row),
      disabled: locked,
    },
    {
      type: ComponentType.BUTTON,
      style: ButtonStyle.PRIMARY,
      label: "Leave feedback",
      custom_id: customId("feedback", row),
    },
  ];

  return buttons;
}

/**
 * Shown once the vote splits. The directors talk it through wherever they talk,
 * and one of them records the result here.
 *
 * These stay visible after a final is recorded, so pressing the other one
 * corrects a misclick - there is no separate undo.
 */
function finalRow(row: number, decision: Decision): Button[] {
  if (!hasSplit(decision)) return [];
  const chosen = decision.final?.outcome;
  return [
    {
      type: ComponentType.BUTTON,
      style: chosen === "yes" ? ButtonStyle.SUCCESS : ButtonStyle.SECONDARY,
      label: "Final Yes",
      custom_id: customId("final-yes", row),
    },
    {
      type: ComponentType.BUTTON,
      style: chosen === "no" ? ButtonStyle.DANGER : ButtonStyle.SECONDARY,
      label: "Final No",
      custom_id: customId("final-no", row),
    },
  ];
}

/**
 * The doc's terminal step: "Unanimous Yes unlocks [Send acceptance]."
 *
 * Rendered locked. Actually sending is rank 27 (email), which is not built - so
 * the card shows the gate was reached without pretending it can act on it.
 */
function sendRow(status: DecisionStatus, emailSendsEnabled: boolean): Button[] {
  if (!isSettled(status)) return [];
  return [
    {
      type: ComponentType.BUTTON,
      style: status === "accepted" ? ButtonStyle.SUCCESS : ButtonStyle.SECONDARY,
      label: status === "accepted" ? "Send acceptance" : "Send rejection",
      custom_id: `app|send-${status}|0`,
      disabled: !emailSendsEnabled,
    },
  ];
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
  if (decision && decidable) {
    blocks.push(renderDecision(decision, directorIds, minVotes));
    fields.push(...feedbackFields(decision, directorIds));
  }

  if (opts.typeWarning) blocks.push(`⚠️ ${opts.typeWarning}`);
  if (unconfigured.length > 0) {
    blocks.push(`⚠️ Not configured in columns.ts: ${unconfigured.join(", ")}`);
  }

  const rows: Button[][] = [];
  if (decision && decidable) {
    rows.push(decisionRow(row.row, decision));
    const final = finalRow(row.row, decision);
    if (final.length > 0) rows.push(final);
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

  const send = decidable ? sendRow(status, false) : [];
  if (send.length > 0) rows.push(send);

  const footerStatus = decidable ? `${opts.state} · ${status}` : opts.state;

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
    components: rows.map((components) => ({
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
  if (known) return buildOneLiner(row);

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
