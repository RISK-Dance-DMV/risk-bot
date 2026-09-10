/**
 * The terminal decision (design doc rank 23, extended).
 *
 *   [WELCOME TO RISK] [Reject from RISK] [Waitlist]
 *
 * Reachable two ways: directly once the vote is unanimous, or after an
 * interview. Each drafts the matching §27 email; nothing is sent until a human
 * approves that draft.
 *
 * Welcoming and waitlisting collect a placement first, then feedback — so it's
 * three steps, not one. That's deliberate: this is the message the applicant
 * actually reads.
 */
import { CARD_COLUMNS, PINNED } from "../config/columns";
import { getDirectorIds } from "../config/directors";
import { getNumber } from "../config/settings";
import { formatSubunits, type Subunit } from "../config/subunits";
import { createInvite, resolveChannelId } from "../discord/rest";
import { modalValue } from "../discord/respond";
import {
  ComponentType,
  InteractionResponseType,
  MODAL_TEXT_LIMIT,
  TextInputStyle,
  type Interaction,
  type MessagePayload,
} from "../discord/types";
import type { Draft } from "../drafts/draft";
import { registerPublishHook } from "../drafts/hooks";
import { createDraft } from "../drafts/service";
import { loadTemplates } from "../email/service";
import {
  findTemplate,
  mergeFieldsIn,
  renderTemplate,
  type Template,
} from "../email/templates";
import type { Env } from "../env";
import {
  agreedPlacement,
  decisionStatus,
  OUTCOME_LABEL,
  outcomeTemplateKey,
  type ApplicationOutcome,
  type OutcomeRecord,
} from "./decision";
import { cell, parseRow, wantsFeedback } from "./fields";
import { getRecord, putRecord, refreshCard, type CardRecord } from "./intake";

const FEEDBACK_INPUT = "feedback";

const DAY = 24 * 60 * 60 * 1000;

/** Placement is meaningless for a rejection. */
export function needsPlacement(outcome: ApplicationOutcome): boolean {
  return outcome !== "rejected";
}

/**
 * Step 1 — the button. Puts the card into a pending state; nothing is recorded
 * and no email exists yet.
 *
 * Waitlisting someone already waitlisted is a snooze instead: it pushes their
 * revisit date out and sends nothing, because they already got the notice.
 */
export async function beginOutcome(
  env: Env,
  row: number,
  userId: string,
  outcome: ApplicationOutcome,
): Promise<{ snoozed: true; message: MessagePayload } | { snoozed: false; record: CardRecord }> {
  const record = await getRecord(env, row);
  if (!record?.values) {
    return { snoozed: true, message: { content: `Row ${row} isn't on file.` } };
  }

  if (outcome === "waitlisted" && record.outcome?.outcome === "waitlisted") {
    const days = await getNumber(env, "waitlist_revisit_days");
    const revisitAt = new Date(Date.now() + days * DAY).toISOString();
    const updated: CardRecord = {
      ...record,
      outcome: { ...record.outcome, revisitAt },
      pending: undefined,
    };
    await putRecord(env, updated);
    await refreshCard(env, updated);
    return {
      snoozed: true,
      message: {
        content: `Still waitlisted — they'll resurface in ${days} days. No second email was drafted.`,
      },
    };
  }

  // Seed the placement from what the vote agreed, so confirming an unchanged
  // placement is one tap. A split agreed nothing, and seeds nothing.
  const [directorIds, minVotes] = await Promise.all([
    getDirectorIds(env),
    getNumber(env, "decision_min_votes"),
  ]);
  const agreed =
    record.decision && decisionStatus(record.decision, directorIds, minVotes) === "accepted"
      ? (agreedPlacement(record.decision, directorIds) ?? [])
      : [];

  const updated: CardRecord = {
    ...record,
    pending: {
      outcome,
      startedBy: userId,
      ...(agreed.length > 0 ? { subunits: agreed } : {}),
    },
  };
  await putRecord(env, updated);
  await refreshCard(env, updated);
  return { snoozed: false, record: updated };
}

/** Step 2 — the placement select. Only for welcomed and waitlisted. */
export async function setPlacement(
  env: Env,
  row: number,
  subunits: string[],
): Promise<CardRecord | null> {
  const record = await getRecord(env, row);
  if (!record?.pending) return null;

  const updated: CardRecord = {
    ...record,
    pending: { ...record.pending, subunits },
  };
  await putRecord(env, updated);
  return updated;
}

/**
 * Step 3 — the feedback modal, pre-filled with what the directors wrote.
 *
 * Their notes are the raw material, not the message: this is composed once, at
 * outcome time, into the text the applicant will actually read.
 */
export function outcomeFeedbackModal(row: number, record: CardRecord | null): unknown {
  const notes = Object.values(record?.decision?.feedback ?? {})
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n\n");

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `app|outcome-save|${row}`,
      title: "Feedback for the applicant",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: FEEDBACK_INPUT,
              style: TextInputStyle.PARAGRAPH,
              label: "They will read this",
              placeholder: "Composed from the directors' notes — edit freely.",
              max_length: MODAL_TEXT_LIMIT,
              required: false,
              value: notes.slice(0, MODAL_TEXT_LIMIT),
            },
          ],
        },
      ],
    },
  };
}

export function readOutcomeModal(interaction: Interaction): string {
  return modalValue(interaction, FEEDBACK_INPUT).trim();
}

/**
 * Invites are minted per acceptance, since they expire.
 *
 * A fixed URL in config wins where one is set — the bot can't create an invite
 * to a server it hasn't joined, and the dance guild is exactly that case until
 * the trainee ranks land. A fixed link should be a non-expiring one, or it
 * becomes a link that works right up until the day it doesn't.
 */
async function inviteLinks(env: Env): Promise<Record<string, string>> {
  const days = await getNumber(env, "invite_days");
  const maxAge = days * 24 * 60 * 60;
  const links: Record<string, string> = {};

  const targets: [string, string, string, string | undefined][] = [
    [
      "community_invite",
      env.GUILD_COMMUNITY_ID,
      env.CH_COMMUNITY_INVITE,
      env.COMMUNITY_INVITE_URL,
    ],
    ["dance_invite", env.GUILD_DANCE_ID, env.CH_DANCE_INVITE, env.DANCE_INVITE_URL],
  ];

  for (const [field, guildId, channelName, fixed] of targets) {
    if (fixed) {
      links[field] = fixed;
      continue;
    }
    if (!guildId || !channelName) continue;
    try {
      const channelId = await resolveChannelId(env, guildId, channelName);
      links[field] = await createInvite(env, channelId, maxAge);
    } catch (err) {
      // Left unset on purpose: an unfilled merge field refuses the draft, which
      // is far better than emailing someone a link that doesn't work.
      console.error("invite generation failed", field, err);
    }
  }
  return links;
}

/** Step 4 — compose the email and draft it. */
export async function completeOutcome(
  env: Env,
  row: number,
  userId: string,
  feedback: string,
): Promise<MessagePayload> {
  const record = await getRecord(env, row);
  if (!record?.values) return { content: `Row ${row} isn't on file.` };
  if (!record.pending) {
    return { content: "That decision timed out — press the button again." };
  }

  const outcome = record.pending.outcome;
  const subunits = (record.pending.subunits ?? []) as Subunit[];
  if (needsPlacement(outcome) && subunits.length === 0) {
    return { content: "Pick a placement first." };
  }

  const application = parseRow(row, record.values);
  const email = cell(record.values, PINNED.email);
  if (!email) return { content: `No email on row ${row}, so there's nobody to write to.` };

  const feedbackColumn = CARD_COLUMNS.find((c) => c.key === "feedback")?.column ?? null;
  const templateKey = outcomeTemplateKey(
    outcome,
    wantsFeedback(cell(record.values, feedbackColumn)),
  );

  const placed = formatSubunits(subunits);
  const merge: Record<string, string> = {
    name: application.name || "there",
    subunits: placed,
    subunit: placed,
    feedback,
  };

  let templates: Template[];
  try {
    templates = await loadTemplates(env);
  } catch (err) {
    return {
      content: `❌ Couldn't read the templates sheet: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const template = findTemplate(templates, templateKey);
  if (!template) {
    const available = templates.map((t) => t.key).join(", ") || "none";
    return { content: `❌ No template named "${templateKey}". Available: ${available}.` };
  }

  // Mint invites only when this template actually asks for one — they're
  // real, time-limited links, not something to create speculatively.
  const fields = mergeFieldsIn(`${template.subject}\n${template.body}`);
  if (fields.some((f) => /invite/i.test(f))) {
    Object.assign(merge, await inviteLinks(env));
  }

  const rendered = renderTemplate(template, merge);
  if (!rendered.ok) return { content: `❌ ${rendered.reason}` };

  const draft = await createDraft(env, {
    kind: templateKey,
    content: rendered.body,
    target: { kind: "email", to: email, subject: rendered.subject },
    confirmation: { guild: "community", channel: env.CH_AUDITION_REVIEW },
    meta: { hook: "application-outcome", row: String(row) },
  });
  if (!draft.ok) return { content: `❌ ${draft.reason}` };

  const revisitAt =
    outcome === "waitlisted"
      ? new Date(
          Date.now() + (await getNumber(env, "waitlist_revisit_days")) * DAY,
        ).toISOString()
      : undefined;

  const settled: OutcomeRecord = {
    outcome,
    by: userId,
    at: new Date().toISOString(),
    ...(subunits.length > 0 ? { subunits } : {}),
    ...(feedback ? { feedback } : {}),
    ...(revisitAt ? { revisitAt } : {}),
    draftId: draft.draft.id,
  };

  const updated: CardRecord = { ...record, outcome: settled, pending: undefined };
  await putRecord(env, updated);
  await refreshCard(env, updated);

  const placement = subunits.length > 0 ? ` (${formatSubunits(subunits)})` : "";
  return {
    content: `Recorded **${OUTCOME_LABEL[outcome]}**${placement} and drafted the *${templateKey}* email. **Nothing is sent** until someone approves it in #${env.CH_AUDITION_REVIEW}.`,
  };
}

/** Marks the outcome as actually communicated once its draft is published. */
export async function onOutcomePublished(env: Env, draft: Draft): Promise<void> {
  const row = Number(draft.meta?.row);
  if (!Number.isFinite(row)) return;

  const record = await getRecord(env, row);
  // Ignore a stale draft: the outcome may have been changed since.
  if (!record?.outcome || record.outcome.draftId !== draft.id) return;

  const outcome: OutcomeRecord = { ...record.outcome, sentAt: new Date().toISOString() };
  const updated: CardRecord = { ...record, outcome };
  await putRecord(env, updated);
  await refreshCard(env, updated);
}

registerPublishHook("application-outcome", onOutcomePublished);
