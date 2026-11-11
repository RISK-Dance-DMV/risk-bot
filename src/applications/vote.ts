/**
 * Recording decisions (design doc rank 23).
 *
 * Every click is recorded with who made it. Nothing here sends anything - the
 * terminal step is rank 27 (email), which is not built.
 */
import { getDirectorIds } from "../config/directors";
import { isEnabled } from "../config/flags";
import { getNumber } from "../config/settings";
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
import {
  agreedPlacement,
  decisionStatus,
  emptyDecision,
  hasSplit,
  isSettled,
  type Ballot,
  type Decision,
} from "./decision";
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
async function announce(
  env: Env,
  record: CardRecord,
  directorIds: readonly string[],
  body: string,
): Promise<void> {
  if (directorIds.length === 0) return;

  const quiet = await isEnabled(env, "quiet_pings");

  // Into the applicant's thread where there is one - see announceOnCard.
  const target = record.threadId ?? record.channelId;
  const link = record.threadId
    ? ""
    : `\nhttps://discord.com/channels/${env.GUILD_COMMUNITY_ID}/${record.channelId}/${record.messageId}`;
  await postMessage(env, target, {
    content: quiet ? `${body}${link}` : `${directorIds.map(mention).join(" ")} — ${body}${link}`,
    allowed_mentions: { parse: [], users: quiet ? [] : [...directorIds] },
  });
}

function applicantName(record: CardRecord): string {
  const name = record.values ? parseRow(record.row, record.values).name : "";
  return name || `row ${record.row}`;
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

  const [directorIds, minVotes] = await Promise.all([
    getDirectorIds(env),
    getNumber(env, "decision_min_votes"),
  ]);
  const status = decisionStatus(decision, directorIds, minVotes);

  // Both announcements fire at most once, and only for what the vote itself
  // reached - a decision recorded by hand needs no telling, the person who
  // recorded it was there.
  let body: string | null = null;

  if (hasSplit(decision) && !decision.final && !decision.pingedDiscussion) {
    decision.pingedDiscussion = true;
    body = `**${applicantName(loaded.record)}** — you didn't all vote the same placement. Worth a conversation, then record it on the card.`;
  } else if (!decision.final && !decision.pingedSettled && isSettled(status)) {
    decision.pingedSettled = true;
    const agreed = agreedPlacement(decision, directorIds) ?? [];
    body =
      status === "accepted"
        ? `**${applicantName(loaded.record)}** — everyone voted **${agreed.join(", ")}**. Ready to interview or make an offer.`
        : `**${applicantName(loaded.record)}** — everyone voted no. Ready to send a rejection.`;
  }

  await commit(env, loaded.record, decision);
  if (body) await announce(env, loaded.record, directorIds, body);
}

/**
 * The placement select shown on a split. Settles the discussion *and* records
 * what it settled on, which unlocks the interview and seeds the outcome step.
 */
export async function recordFinalPlacement(
  env: Env,
  row: number,
  userId: string,
  subunits: string[],
): Promise<void> {
  const loaded = await loadDecidable(env, row);
  if (!loaded || subunits.length === 0) return;

  await commit(env, loaded.record, {
    ...loaded.decision,
    final: { outcome: "yes", by: userId, at: new Date().toISOString(), subunits },
  });
}

/**
 * Legacy [Move onto Interview]. Nothing renders this button any more — a split
 * asks for the placement instead — but cards posted before that change still
 * carry it, and a button that silently does nothing is worse than one that
 * records what it always did.
 */
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

/**
 * [Reject from RISK] on a split card — settles the discussion *and* opens the
 * rejection straight away, because deciding not to take someone and telling them
 * are the same act.
 *
 * Writes once and skips redrawing the card: the modal has to be the immediate
 * response, and the card gets refreshed when the rejection is completed anyway.
 */
export async function rejectAfterDiscussion(
  env: Env,
  row: number,
  userId: string,
): Promise<CardRecord | null> {
  const loaded = await loadDecidable(env, row);
  if (!loaded) return null;

  const updated: CardRecord = {
    ...loaded.record,
    decision: {
      ...loaded.decision,
      final: { outcome: "no", by: userId, at: new Date().toISOString() },
    },
    pending: { outcome: "rejected", startedBy: userId },
  };
  await putRecord(env, updated);
  return updated;
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
              label: "Feedback for the applicant",
              placeholder:
                "The applicant reads this. Hidden from the other directors until all of you have written.",
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
