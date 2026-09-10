/**
 * One-off replies to videographer/editor applicants (design doc rank 22).
 *
 * Their card is a dead end by design - no votes, no interview - but they still
 * need an answer. Free text rather than a template, because there is no
 * videographer template in §27 and these are one at a time.
 */
import { PINNED } from "../config/columns";
import { modalValue } from "../discord/respond";
import {
  ComponentType,
  InteractionResponseType,
  MODAL_TEXT_LIMIT,
  TextInputStyle,
  type Interaction,
  type MessagePayload,
} from "../discord/types";
import { CONTENT_LIMIT } from "../drafts/draft";
import { createDraft } from "../drafts/service";
import type { Env } from "../env";
import { cell, parseRow } from "./fields";
import { getRecord } from "./intake";

const INPUTS = { subject: "subject", body: "body" } as const;

export async function replyModalFor(env: Env, row: number): Promise<unknown> {
  const record = await getRecord(env, row);
  const name = record?.values ? parseRow(row, record.values).name : "";

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `app|reply-save|${row}`,
      title: "Draft a reply",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: INPUTS.subject,
              style: TextInputStyle.SHORT,
              label: "Subject",
              required: true,
              value: "About your RISK application",
            },
          ],
        },
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: INPUTS.body,
              style: TextInputStyle.PARAGRAPH,
              label: "Message",
              required: true,
              max_length: Math.min(MODAL_TEXT_LIMIT, CONTENT_LIMIT),
              value: name ? `Hi ${name},\n\n` : "",
            },
          ],
        },
      ],
    },
  };
}

export function readReplyModal(interaction: Interaction): {
  subject: string;
  body: string;
} {
  return {
    subject: modalValue(interaction, INPUTS.subject),
    body: modalValue(interaction, INPUTS.body),
  };
}

export async function draftReply(
  env: Env,
  row: number,
  input: { subject: string; body: string },
): Promise<MessagePayload> {
  const record = await getRecord(env, row);
  if (!record?.values) return { content: `Row ${row} isn't on file.` };

  const email = cell(record.values, PINNED.email);
  if (!email) return { content: `No email on row ${row}, so there's nobody to write to.` };
  if (!input.subject.trim()) return { content: "That reply needs a subject." };

  const draft = await createDraft(env, {
    kind: "videographer reply",
    content: input.body,
    target: { kind: "email", to: email, subject: input.subject.trim() },
    confirmation: { guild: "community", channel: env.CH_AUDITION_REVIEW },
  });
  if (!draft.ok) return { content: `❌ ${draft.reason}` };

  return {
    content: `Drafted a reply to \`${email}\`. **Nothing is sent** until someone approves it in #${env.CH_AUDITION_REVIEW}.`,
  };
}
