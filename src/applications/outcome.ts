/**
 * The terminal decision (design doc rank 23, extended).
 *
 *   [WELCOME TO RISK] [Reject from RISK] [Waitlist]
 *
 * Available two ways: directly once the vote is unanimous, or after an
 * interview. Each one drafts the matching §27 email; nothing is sent until a
 * human approves that draft.
 */
import { CARD_COLUMNS, PINNED } from "../config/columns";
import type { MessagePayload } from "../discord/types";
import type { Draft } from "../drafts/draft";
import { registerPublishHook } from "../drafts/hooks";
import { createDraft } from "../drafts/service";
import { renderForSend } from "../email/service";
import type { Env } from "../env";
import {
  OUTCOME_LABEL,
  outcomeTemplateKey,
  type ApplicationOutcome,
  type OutcomeRecord,
} from "./decision";
import { cell, parseRow, wantsFeedback } from "./fields";
import { getRecord, putRecord, refreshCard, type CardRecord } from "./intake";

export async function recordOutcome(
  env: Env,
  row: number,
  userId: string,
  outcome: ApplicationOutcome,
): Promise<MessagePayload> {
  const record = await getRecord(env, row);
  if (!record?.values) return { content: `Row ${row} isn't on file.` };

  const application = parseRow(row, record.values);
  const email = cell(record.values, PINNED.email);
  if (!email) return { content: `No email on row ${row}, so there's nobody to write to.` };

  const feedbackColumn = CARD_COLUMNS.find((c) => c.key === "feedback")?.column ?? null;
  const templateKey = outcomeTemplateKey(
    outcome,
    wantsFeedback(cell(record.values, feedbackColumn)),
  );

  const rendered = await renderForSend(env, templateKey, {
    name: application.name || "there",
  });
  if (!rendered.ok) return { content: `❌ ${rendered.reason}` };

  const draft = await createDraft(env, {
    kind: templateKey,
    content: rendered.body,
    target: { kind: "email", to: email, subject: rendered.subject },
    confirmation: { guild: "community", channel: env.CH_AUDITION_REVIEW },
    meta: { hook: "application-outcome", row: String(row) },
  });
  if (!draft.ok) return { content: `❌ ${draft.reason}` };

  const updated: CardRecord = {
    ...record,
    outcome: {
      outcome,
      by: userId,
      at: new Date().toISOString(),
      draftId: draft.draft.id,
    },
  };
  await putRecord(env, updated);
  await refreshCard(env, updated);

  return {
    content: `Recorded **${OUTCOME_LABEL[outcome]}** and drafted the *${templateKey}* email. **Nothing is sent** until someone approves it in #${env.CH_AUDITION_REVIEW}.`,
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
