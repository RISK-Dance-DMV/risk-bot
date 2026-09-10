/**
 * Recording decisions (design doc rank 23).
 *
 * Every click is recorded with who made it. Nothing here sends anything - the
 * terminal step is rank 27 (email), which is not built.
 */
import { getDirectorIds } from "../config/directors";
import { modalValue } from "../discord/respond";
import { postMessage } from "../discord/rest";
import {
  ComponentType,
  InteractionResponseType,
  MODAL_TEXT_LIMIT,
  TextInputStyle,
  type Interaction,
} from "../discord/types";
import type { Env } from "../env";
import { isDecidable } from "./card";
import { emptyDecision, hasSplit, type Ballot, type Decision } from "./decision";
import { parseRow } from "./fields";
import { getRecord, putRecord, refreshCard, type CardRecord } from "./intake";
import { mention } from "./text";

const FEEDBACK_INPUT_ID = "text";

async function loadDecidable(
  env: Env,
  row: number,
): Promise<{ record: CardRecord; decision: Decision } | null> {
  const record = await getRecord(env, row);
  if (!record || !isDecidable(record.state)) return null;
  return { record, decision: record.decision ?? emptyDecision() };
}

async function commit(env: Env, record: CardRecord, decision: Decision): Promise<void> {
  const updated: CardRecord = { ...record, decision };
  await putRecord(env, updated);
  await refreshCard(env, updated);
}

/**
 * Announces a split once, by mentioning the directors directly.
 *
 * A separate message rather than an edit: editing the card would not notify
 * anyone, and the point of the announcement is that it reaches people.
 */
async function announceSplit(env: Env, record: CardRecord): Promise<void> {
  const directorIds = await getDirectorIds(env);
  if (directorIds.length === 0) return;

  const name = record.values ? parseRow(record.row, record.values).name : `row ${record.row}`;
  const link = `https://discord.com/channels/${env.GUILD_COMMUNITY_ID}/${record.channelId}/${record.messageId}`;

  await postMessage(env, record.channelId, {
    content: `${directorIds.map(mention).join(" ")} — split vote on **${name || `row ${record.row}`}**. Worth a conversation, then record it on the card.\n${link}`,
    allowed_mentions: { parse: [], users: directorIds },
  });
}

export async function applyBallot(
  env: Env,
  row: number,
  userId: string,
  ballot: Ballot,
): Promise<void> {
  const loaded = await loadDecidable(env, row);
  if (!loaded) return;

  const decision: Decision = {
    ...loaded.decision,
    ballots: { ...loaded.decision.ballots, [userId]: ballot },
  };

  const shouldAnnounce =
    hasSplit(decision) && !decision.final && !decision.pingedDiscussion;
  if (shouldAnnounce) decision.pingedDiscussion = true;

  await commit(env, loaded.record, decision);
  if (shouldAnnounce) await announceSplit(env, loaded.record);
}

/** [Final Yes] / [Final No] — the recorded outcome of the discussion. */
export async function recordFinal(
  env: Env,
  row: number,
  userId: string,
  outcome: "yes" | "no",
): Promise<void> {
  const loaded = await loadDecidable(env, row);
  if (!loaded) return;

  await commit(env, loaded.record, {
    ...loaded.decision,
    final: { outcome, by: userId, at: new Date().toISOString() },
  });
}

export async function saveFeedback(
  env: Env,
  row: number,
  userId: string,
  text: string,
): Promise<void> {
  const loaded = await loadDecidable(env, row);
  if (!loaded) return;

  const feedback = { ...loaded.decision.feedback };
  const trimmed = text.trim();
  if (trimmed) {
    feedback[userId] = { text: trimmed, at: new Date().toISOString() };
  } else {
    // Submitting an empty box withdraws feedback rather than storing a blank.
    delete feedback[userId];
  }

  await commit(env, loaded.record, { ...loaded.decision, feedback });
}

/** Modals must be the immediate response, so this does no network work. */
export function feedbackModalResponse(row: number, existing: string): unknown {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `app|feedback-save|${row}`,
      title: `Feedback — row ${row}`,
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: FEEDBACK_INPUT_ID,
              style: TextInputStyle.PARAGRAPH,
              label: "Your feedback",
              placeholder: "Shown to the others once everyone has written theirs.",
              max_length: MODAL_TEXT_LIMIT,
              required: false,
              value: existing.slice(0, MODAL_TEXT_LIMIT),
            },
          ],
        },
      ],
    },
  };
}

export function modalFeedbackValue(interaction: Interaction): string {
  return modalValue(interaction, FEEDBACK_INPUT_ID);
}
