/**
 * The two audition cards (design doc rank 12). Pure.
 *
 * An audition is reviewed twice, by different people in different servers, so
 * it has two cards rather than one that changes meaning halfway through:
 *
 *   proposal → #coaches-bot-confirmation (dance)      is this song alright?
 *   submission → #audition-review        (community)  is this audition a pass?
 *
 * The doc puts both in #audition-review. Splitting them follows where the work
 * actually happens: coaches answer proposals in the dance server, and the video
 * is judged in the same channel the crew judges applicant videos.
 */
import { ButtonStyle, ComponentType, type MessagePayload } from "../discord/types";
import { escapeMd, mention, truncate } from "../applications/text";
import { emptyDecision, type Decision } from "../applications/decision";
import {
  isReviewSettled,
  renderReview,
  reviewFeedbackFields,
  reviewPlacement,
  reviewStatus,
} from "./review";
import {
  auditionState,
  deadline,
  extensionPending,
  type AuditionRecord,
} from "./audition";

export type AuditionAction =
  | "approve"
  | "another-song"
  | "another-song-save"
  | "decline"
  | "decline-save"
  | "extend-grant"
  | "extend-deny"
  | "extend-deny-save"
  | "vote-pass"
  | "vote-no"
  | "feedback"
  | "feedback-save"
  | "final-pass"
  | "final-no"
  | "send-result"
  | "send-confirm"
  | "sim-agree"
  | "sim-split";

const ACTIONS: AuditionAction[] = [
  "approve",
  "another-song",
  "another-song-save",
  "decline",
  "decline-save",
  "extend-grant",
  "extend-deny",
  "extend-deny-save",
  "vote-pass",
  "vote-no",
  "feedback",
  "feedback-save",
  "final-pass",
  "final-no",
  "send-result",
  "send-confirm",
  "sim-agree",
  "sim-split",
];

const PREFIX = "aud";

/**
 * Keyed by audition id, not by trainee: a trainee has several attempts, and a
 * button left on an old card must never act on the current one.
 */
export function auditionCustomId(action: AuditionAction, auditionId: string): string {
  return `${PREFIX}|${action}|${auditionId}`;
}

export function parseAuditionCustomId(
  value: string,
): { action: AuditionAction; auditionId: string } | null {
  const [prefix, action, auditionId] = value.split("|");
  if (prefix !== PREFIX || !action || !auditionId) return null;
  if (!ACTIONS.includes(action as AuditionAction)) return null;
  if (!/^[0-9a-f]{6,}$/.test(auditionId)) return null;
  return { action: action as AuditionAction, auditionId };
}

/** Discord renders these in each reader's own timezone. */
function discordDate(iso: string): string {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(unix) ? `<t:${unix}:D> (<t:${unix}:R>)` : iso;
}

function songLines(audition: AuditionRecord): string[] {
  const at = audition.timestamp.trim();
  return [
    `**Auditioning for:** ${escapeMd(audition.targetSubunit)}`,
    `**Song:** ${escapeMd(truncate(audition.song, 200))}${at ? ` · from ${escapeMd(truncate(at, 40))}` : ""}`,
    audition.songLink,
  ];
}

// ------------------------------------------------ the coach's proposal card

const PROPOSAL_LINE: Record<string, string> = {
  proposed: "🎵 **Proposed** — waiting on a coach.",
  approved: "✅ **Approved** — waiting on their video.",
  submitted: "📼 **Submitted** — being reviewed in #audition-review.",
  passed: "🎉 **Passed**",
  failed: "🚫 **Did not pass**",
  lapsed: "⌛ **Lapsed** — the deadline passed with nothing submitted.",
  declined: "🚫 **Declined this cycle** — no audition from them this cycle.",
  "another-song":
    "🔁 **Another song asked for** — the proposal, not an audition; they can propose again.",
};

/**
 * States where the proposal is finished with, however it ended.
 *
 * These collapse to a single muted line. A dead proposal still belongs in the
 * trainee's thread — it's the record of what was said — but at full size it
 * competes for attention with the one proposal that actually needs answering.
 */
const CLOSED_LABEL: Record<string, string> = {
  "another-song": "🔁 Another song asked for",
  declined: "🚫 Declined this cycle",
  lapsed: "⌛ Lapsed",
  passed: "🎉 Passed",
  failed: "🚫 Did not pass",
};

/**
 * Discord's `-#` subtext: small and grey. The closest thing to greying a
 * message out, short of deleting it.
 */
function closedProposalCard(audition: AuditionRecord, label: string): MessagePayload {
  const lines = [
    `-# ${label} · **${escapeMd(truncate(audition.song, 60))}** · ${mention(audition.discordId)}`,
  ];
  if (audition.proposalNote) {
    lines.push(`-# ↳ ${escapeMd(truncate(audition.proposalNote, 160))}`);
  }
  return {
    content: lines.join("\n"),
    allowed_mentions: { parse: [] },
    flags: 4,
    components: [],
  };
}

export function renderProposalCard(audition: AuditionRecord): MessagePayload {
  const state = auditionState(audition);

  // Nothing further will happen to this one, and an extension can't be pending
  // on a proposal that's over.
  const closed = CLOSED_LABEL[state];
  if (closed) return closedProposalCard(audition, closed);

  const lines: string[] = [
    `🎤 **Audition proposal — ${mention(audition.discordId)}**`,
    PROPOSAL_LINE[state] ?? state,
    ...songLines(audition),
  ];

  const due = deadline(audition);
  if (due && (state === "approved" || state === "submitted")) {
    lines.push(
      audition.extendedTo
        ? `**Due** ${discordDate(due)} — extended.`
        : `**Due** ${discordDate(due)}`,
    );
  }

  if (extensionPending(audition)) {
    const asked = audition.extension?.days ?? 0;
    lines.push(
      `⏳ **${asked} more day${asked === 1 ? "" : "s"} requested** — ` +
        escapeMd(truncate(audition.extension?.reason ?? "", 400)),
    );
  } else if (audition.extension?.granted === false) {
    lines.push(
      `Extension denied by ${mention(audition.extension.by ?? "")}` +
        (audition.extension.note
          ? ` — ${escapeMd(truncate(audition.extension.note, 300))}`
          : "."),
    );
  }

  if (audition.proposalNote) {
    lines.push(
      `**What they were told:** ${escapeMd(truncate(audition.proposalNote, 500))}`,
    );
  }
  if (audition.decidedBy) lines.push(`Answered by ${mention(audition.decidedBy)}.`);

  return message(lines, proposalRows(audition));
}

/**
 * One question at a time.
 *
 * An extension request outranks the rest: it's the only thing on the card with
 * someone waiting on an answer, and leaving [Approve] beside it invites
 * answering a question nobody asked.
 */
function proposalRows(audition: AuditionRecord): Row[] {
  const id = audition.auditionId;

  if (extensionPending(audition)) {
    return [
      row([
        button(
          ButtonStyle.SUCCESS,
          `Grant ${audition.extension?.days ?? 0} day${audition.extension?.days === 1 ? "" : "s"}`,
          auditionCustomId("extend-grant", id),
        ),
        button(ButtonStyle.SECONDARY, "Deny", auditionCustomId("extend-deny", id)),
      ]),
    ];
  }

  if (auditionState(audition) !== "proposed") return [];

  return [
    row([
      button(ButtonStyle.SUCCESS, "Approve", auditionCustomId("approve", id)),
      button(ButtonStyle.SECONDARY, "Ask for another song", auditionCustomId("another-song", id)),
      button(ButtonStyle.DANGER, "Decline this cycle", auditionCustomId("decline", id)),
    ]),
  ];
}

// ------------------------------------------------ the submitted audition card

export interface ReviewOptions {
  directorIds: readonly string[];
  minVotes: number;
  /** features.simulate_votes — adds the two test buttons. */
  simulate?: boolean;
}

/**
 * The trainee's audition, laid out like an applicant's card — because it is the
 * same judgement, made by the same people, on the same kind of evidence.
 *
 * What it doesn't carry: an interview row and anything that sends email. A
 * trainee is already in the building; the result reaches them by DM.
 */
export function renderReviewCard(
  audition: AuditionRecord,
  opts: ReviewOptions,
): MessagePayload {
  const decision = audition.decision ?? emptyDecision();
  const status = reviewStatus(decision, opts.minVotes);

  // Fields rather than a run of bold lines: each fact is labelled, and a
  // reviewer scanning a stack of these finds the same thing in the same place.
  const fields = [
    { name: "Auditioning for", value: escapeMd(audition.targetSubunit), inline: true },
    { name: "Song", value: escapeMd(truncate(audition.song, 200)), inline: true },
    {
      name: "From",
      value: audition.timestamp.trim() ? escapeMd(truncate(audition.timestamp, 60)) : "—",
      inline: true,
    },
    { name: "Song reference", value: audition.songLink, inline: false },
    {
      name: "Audition video",
      value: audition.submissionUrl ?? "— nothing submitted yet",
      inline: false,
    },
    ...reviewFeedbackFields(decision, opts.directorIds, opts.minVotes),
  ];

  const blocks: string[] = [renderReview(decision, opts.directorIds, opts.minVotes)];

  if (audition.resultSentAt) {
    blocks.push(`📨 Result sent ${discordDate(audition.resultSentAt)}.`);
  }
  if ((audition.subunits ?? []).length > 0) {
    blocks.push(`**Placed in ${(audition.subunits ?? []).join(" + ")}** — role assigned.`);
  }

  const footer = [
    audition.submittedOn ? `submitted ${audition.submittedOn.slice(0, 10)}` : "not submitted",
    status,
  ].join(" · ");

  return {
    embeds: [
      {
        title: truncate(audition.displayName || `Trainee ${audition.discordId}`, 256),
        description: truncate(blocks.join("\n\n"), 4000),
        fields,
        footer: { text: footer },
      },
    ],
    allowed_mentions: { parse: [] },
    // Explicitly 0, not omitted: SUPPRESS_EMBEDS belongs on the plain-text
    // proposal card, where it stops a YouTube unfurl burying the buttons. On a
    // card that IS an embed it suppresses the card itself, and an edit only
    // clears the flag if the edit says so.
    flags: 0,
    components: reviewRows(audition, decision, opts),
  };
}

function reviewRows(
  audition: AuditionRecord,
  decision: Decision,
  opts: ReviewOptions,
): Row[] {
  const id = audition.auditionId;
  const target = audition.targetSubunit;
  const status = reviewStatus(decision, opts.minVotes);
  const rows: Row[] = [];

  // Once the result has gone out there is nothing left to press.
  if (audition.resultSentAt) return rows;

  const split = status === "discussing";

  // Two buttons, not a placement select: they auditioned for one subunit, so
  // the only question is whether that's a pass.
  if (!isReviewSettled(status) && !split) {
    rows.push(
      row([
        button(ButtonStyle.SUCCESS, `Pass — ${target}`, auditionCustomId("vote-pass", id)),
        button(ButtonStyle.DANGER, "Did not pass", auditionCustomId("vote-no", id)),
      ]),
    );
  }

  rows.push(
    row([button(ButtonStyle.PRIMARY, "Leave feedback", auditionCustomId("feedback", id))]),
  );

  if (split && !decision.final) {
    rows.push(
      row([
        button(ButtonStyle.SUCCESS, `Record: pass — ${target}`, auditionCustomId("final-pass", id)),
        button(ButtonStyle.DANGER, "Record: did not pass", auditionCustomId("final-no", id)),
      ]),
    );
  }

  if (opts.simulate && !isReviewSettled(status) && !split) {
    rows.push(
      row([
        button(ButtonStyle.SECONDARY, "🧪 All pass", auditionCustomId("sim-agree", id)),
        button(ButtonStyle.SECONDARY, "🧪 Split", auditionCustomId("sim-split", id)),
      ]),
    );
  }

  // The one click that reaches the trainee. Never automatic.
  if (isReviewSettled(status)) {
    const placed = reviewPlacement(decision, opts.minVotes) ?? [];
    rows.push(
      row([
        button(
          ButtonStyle.SUCCESS,
          placed.length > 0
            ? `Review & send — ${placed.join(" + ")}`
            : "Review & send result",
          auditionCustomId("send-result", id),
        ),
      ]),
    );
  }

  return rows;
}

// ------------------------------------------------------------------ plumbing

interface Button {
  type: number;
  style: number;
  label: string;
  custom_id: string;
}

interface Select {
  type: number;
  custom_id: string;
  placeholder: string;
  min_values: number;
  max_values: number;
  /** Locked once the ballots split — the answer is a decision now, not a vote. */
  disabled?: boolean;
  options: { label: string; value: string }[];
}

type Row = { type: number; components: (Button | Select)[] };

function message(lines: string[], components: Row[]): MessagePayload {
  return {
    content: truncate(lines.join("\n"), 2000),
    allowed_mentions: { parse: [] },
    // The song link is the point of the card; a YouTube unfurl under every one
    // of these would bury the buttons.
    flags: 4,
    components,
  };
}

function row(components: (Button | Select)[]): Row {
  return { type: ComponentType.ACTION_ROW, components };
}

function button(style: number, label: string, custom_id: string): Button {
  return { type: ComponentType.BUTTON, style, label, custom_id };
}
