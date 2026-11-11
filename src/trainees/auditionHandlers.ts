/**
 * Interaction handling for rank 12.
 *
 * Every trainee-facing reply is ephemeral, per the doc — #trainee-bot is a
 * shared channel and an audition is not a group conversation.
 */
import { getCoachRoleId, getDirectorIds, isCoach } from "../config/directors";
import { isEnabled } from "../config/flags";
import { getNumber } from "../config/settings";
import { emptyDecision } from "../applications/decision";
import {
  composeFeedback,
  isReviewSettled,
  resultMessage,
  reviewPlacement,
  reviewStatus,
} from "./review";
import { ephemeral, json } from "../discord/respond";
import { editOriginalResponse, resolveChannelId } from "../discord/rest";
import {
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  MODAL_TEXT_LIMIT,
  TextInputStyle,
  type Interaction,
  type MessagePayload,
} from "../discord/types";
import { modalValue } from "../discord/respond";
import type { Env } from "../env";
import { auditionCustomId, parseAuditionCustomId, type AuditionAction } from "./auditionCard";
import {
  answerExtension,
  castBallot,
  currentAudition,
  decideProposal,
  getAudition,
  recordReviewFinal,
  saveReviewFeedback,
  simulateBallots,
  sendReviewResult,
  proposeAudition,
  reopenAudition,
  requestExtension,
  submitAudition,
  type FlowResult,
} from "./auditionFlow";

function option(interaction: Interaction, sub: string, name: string): string {
  const subcommand = (interaction.data?.options ?? []).find(
    (o) => (o as { name?: string }).name === sub,
  ) as { options?: { name?: string; value?: unknown }[] } | undefined;
  const found = (subcommand?.options ?? []).find((o) => o.name === name);
  return found?.value === undefined ? "" : String(found.value);
}

function subcommandName(interaction: Interaction): string {
  const first = (interaction.data?.options ?? [])[0] as { name?: string } | undefined;
  return first?.name ?? "";
}

function callerId(interaction: Interaction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

/** Server nickname first — it's what coaches will recognise in a thread list. */
function displayNameOf(interaction: Interaction): string {
  const user = interaction.member?.user ?? interaction.user;
  return interaction.member?.nick ?? user?.global_name ?? user?.username ?? "";
}

const said = (result: FlowResult, done: string): MessagePayload => ({
  content: result.ok
    ? result.warning
      ? `${done}\n⚠️ ${result.warning}`
      : done
    : `❌ ${result.reason}`,
});

/**
 * Coaches are read off the clicker's own roles, which arrive in the interaction.
 * No enumeration, so no GUILD_MEMBERS intent and no list to keep in step.
 */
async function callerIsCoach(
  env: Env,
  interaction: Interaction,
  userId: string,
): Promise<boolean> {
  const [coachRoleId, directorIds] = await Promise.all([
    getCoachRoleId(env),
    getDirectorIds(env),
  ]);
  return isCoach(interaction.member?.roles, coachRoleId, directorIds, userId);
}

/**
 * The doc's channel allowlist, checked here rather than assumed.
 *
 * A proposal typed in the wrong channel would still work — the card goes to the
 * coaches either way — but the trainee would have no idea whether it did, and
 * #trainee-bot is where they'll look for the answer.
 */
async function wrongChannel(env: Env, interaction: Interaction): Promise<string | null> {
  let allowed: string;
  try {
    allowed = await resolveChannelId(env, env.GUILD_DANCE_ID, env.CH_TRAINEE_BOT);
  } catch (err) {
    return `Couldn't find #${env.CH_TRAINEE_BOT}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return interaction.channel_id === allowed ? null : `Use this in #${env.CH_TRAINEE_BOT}.`;
}

export async function handleAuditionCommand(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!(await isEnabled(env, "auditions"))) {
    return json(ephemeral("Auditions are switched off."));
  }

  const userId = callerId(interaction);
  if (!userId) return json(ephemeral("Couldn't tell who ran that."));

  const sub = subcommandName(interaction);
  const misplaced = await wrongChannel(env, interaction);
  if (misplaced) return json(ephemeral(misplaced));

  if (sub === "reopen" && !(await callerIsCoach(env, interaction, userId))) {
    return json(ephemeral("Reopening an audition is a coach's call."));
  }

  // Posting a card and DMing a trainee both run past the 3s budget.
  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        payload = await runSubcommand(env, interaction, sub, userId);
      } catch (err) {
        payload = {
          content: `That didn't go through: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await editOriginalResponse(env, interaction.application_id, interaction.token, payload);
    })(),
  );

  return json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL },
  });
}

async function runSubcommand(
  env: Env,
  interaction: Interaction,
  sub: string,
  userId: string,
): Promise<MessagePayload> {
  if (sub === "propose") {
    const result = await proposeAudition(env, userId, {
      targetSubunit: option(interaction, "propose", "subunit"),
      song: option(interaction, "propose", "song"),
      songLink: option(interaction, "propose", "link"),
      timestamp: option(interaction, "propose", "timestamp"),
      displayName: displayNameOf(interaction),
    });
    return said(
      result,
      "🎵 **Proposed.** A coach will take a look and you'll get a DM either way.",
    );
  }

  if (sub === "submit") {
    const result = await submitAudition(env, userId, option(interaction, "submit", "link"));
    return said(
      result,
      "📼 **Submitted.** It's with the reviewers now — you'll get a DM with the result.",
    );
  }

  if (sub === "extend") {
    const days = Number.parseInt(option(interaction, "extend", "days"), 10);
    const result = await requestExtension(
      env,
      userId,
      days,
      option(interaction, "extend", "reason"),
    );
    return said(result, "⏳ **Asked.** A coach will answer and you'll get a DM.");
  }

  if (sub === "reopen") {
    const trainee = option(interaction, "reopen", "trainee");
    const audition = await currentAudition(env, trainee);
    if (!audition) return { content: `❌ <@${trainee}> has no audition on file.` };
    const result = await reopenAudition(env, audition.auditionId);
    return said(result, `Reopened <@${trainee}>'s audition and let them know.`);
  }

  return { content: "Unhandled subcommand." };
}

// ------------------------------------------------------------ card buttons

/** Everything on either card is a coach's call. */
const COACH_ACTIONS: AuditionAction[] = [
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

/**
 * Reviewing a submitted audition is the directors' call, not the coaches' — a
 * coach who works with the trainee every week isn't a neutral judge of them.
 */
const DIRECTOR_ACTIONS: AuditionAction[] = [
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

export function auditionComponent(
  customId: string,
): { action: AuditionAction; auditionId: string } | null {
  return parseAuditionCustomId(customId);
}

export async function handleAuditionComponent(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
  action: AuditionAction,
  auditionId: string,
): Promise<Response> {
  if (!(await isEnabled(env, "auditions"))) {
    return json(ephemeral("Auditions are switched off."));
  }

  const userId = callerId(interaction);
  if (!userId) return json(ephemeral("Couldn't tell who clicked that."));

  if (DIRECTOR_ACTIONS.includes(action)) {
    const directorIds = await getDirectorIds(env);
    if (directorIds.length === 0) {
      return json(
        ephemeral(
          "`config:director_ids` isn't set, so I can't tell who reviews. Nothing was recorded.",
        ),
      );
    }
    if (!directorIds.includes(userId)) {
      return json(ephemeral("Reviewing a trainee audition is a director's call."));
    }
  } else if (COACH_ACTIONS.includes(action) && !(await callerIsCoach(env, interaction, userId))) {
    return json(ephemeral("Auditions are coaches only."));
  }

  // Modals have to be the immediate response; they can't follow a defer. Both
  // rejections take one, because both owe the trainee a reason.
  if (action === "another-song" || action === "decline" || action === "extend-deny") {
    return json(rejectionModal(action, auditionId));
  }

  // Nothing reaches the trainee until someone has read the actual words. The
  // box is prefilled with exactly what would be sent, and is editable — what
  // gets approved is what goes out, not a re-render of it.
  if (action === "send-result") {
    const audition = await getAudition(env, auditionId);
    if (!audition) return json(ephemeral("That audition is no longer on file."));
    if (audition.resultSentAt) return json(ephemeral("The result has already gone out."));

    const [directorIds, minVotes] = await Promise.all([
      getDirectorIds(env),
      getNumber(env, "trainee_min_votes"),
    ]);
    const decision = audition.decision ?? emptyDecision();
    if (!isReviewSettled(reviewStatus(decision, minVotes))) {
      return json(ephemeral("The vote hasn't settled yet."));
    }

    const placed = reviewPlacement(decision, minVotes) ?? [];
    const body = resultMessage(
      audition.targetSubunit,
      placed,
      composeFeedback(decision, directorIds),
    );
    return json(sendPreviewModal(auditionId, body, placed));
  }

  if (action === "feedback") {
    const audition = await getAudition(env, auditionId);
    const existing = audition?.decision?.feedback?.[userId]?.text ?? "";
    return json(reviewFeedbackModal(auditionId, existing));
  }

  const chosen = interaction.data?.values ?? [];
  const note = readRejectionNote(interaction);

  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        payload = await runComponent(env, action, auditionId, userId, chosen, note);
      } catch (err) {
        payload = {
          content: `That didn't go through: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await editOriginalResponse(env, interaction.application_id, interaction.token, payload);
    })(),
  );

  return json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL },
  });
}

const NOTE_INPUT = "note";

const MODAL_COPY = {
  "another-song": {
    save: "another-song-save" as const,
    title: "Ask for another song",
    placeholder: "What's wrong with this song, and what would work better?",
  },
  decline: {
    save: "decline-save" as const,
    title: "Decline this proposal",
    placeholder: "Why this proposal isn't going ahead this cycle.",
  },
  "extend-deny": {
    save: "extend-deny-save" as const,
    title: "Deny the extension",
    placeholder: "Why the original deadline stands.",
  },
};

function rejectionModal(
  action: "another-song" | "decline" | "extend-deny",
  auditionId: string,
): unknown {
  const copy = MODAL_COPY[action];
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: auditionCustomId(copy.save, auditionId),
      title: copy.title,
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: NOTE_INPUT,
              style: TextInputStyle.PARAGRAPH,
              label: "The trainee reads this",
              placeholder: copy.placeholder,
              max_length: MODAL_TEXT_LIMIT,
              required: true,
            },
          ],
        },
      ],
    },
  };
}

/**
 * The last look before it goes. Prefilled with the whole message rather than
 * just the feedback, so what a director reads is what the trainee reads.
 */
function sendPreviewModal(auditionId: string, body: string, placed: string[]): unknown {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: auditionCustomId("send-confirm", auditionId),
      title: placed.length > 0 ? "Review before sending" : "Review before sending",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: NOTE_INPUT,
              style: TextInputStyle.PARAGRAPH,
              label: "Sent to them as a DM — edit freely",
              max_length: MODAL_TEXT_LIMIT,
              required: true,
              value: body.slice(0, MODAL_TEXT_LIMIT),
            },
          ],
        },
      ],
    },
  };
}

function reviewFeedbackModal(auditionId: string, existing: string): unknown {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: auditionCustomId("feedback-save", auditionId),
      title: "Feedback for the trainee",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: NOTE_INPUT,
              style: TextInputStyle.PARAGRAPH,
              label: "They will read this",
              placeholder:
                "Hidden from the other directors until the vote settles, then sent with the result.",
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

export function readRejectionNote(interaction: Interaction): string {
  return modalValue(interaction, NOTE_INPUT);
}

async function runComponent(
  env: Env,
  action: AuditionAction,
  auditionId: string,
  userId: string,
  chosen: string[],
  note: string,
): Promise<MessagePayload> {
  switch (action) {
    case "approve":
      return said(
        await decideProposal(env, auditionId, userId, "approve"),
        "Approved, and they've been told the deadline.",
      );
    case "another-song-save":
      return said(
        await decideProposal(env, auditionId, userId, "another-song", note),
        "Asked for another song. The proposal is closed, not an audition — they've been sent your note and can propose again.",
      );
    case "decline-save":
      return said(
        await decideProposal(env, auditionId, userId, "decline", note),
        "Declined for this cycle, and they've been sent your note.",
      );
    case "extend-grant":
      return said(await answerExtension(env, auditionId, userId, true), "Extension granted.");
    case "extend-deny-save":
      return said(
        await answerExtension(env, auditionId, userId, false, note),
        "Extension denied — the original deadline stands, and they've been sent your note.",
      );
    case "vote-pass":
      return said(
        await castBallot(env, auditionId, userId, true),
        "Voted **pass**. Nothing reaches them until someone sends the result.",
      );
    case "vote-no":
      return said(
        await castBallot(env, auditionId, userId, false),
        "Voted **did not pass**. Nothing reaches them until someone sends the result.",
      );
    case "feedback-save":
      return said(
        await saveReviewFeedback(env, auditionId, userId, note),
        "Saved. Hidden from the others until the vote settles.",
      );
    case "final-pass":
      return said(
        await recordReviewFinal(env, auditionId, userId, true),
        "Recorded as a pass after discussion.",
      );
    case "final-no":
      return said(
        await recordReviewFinal(env, auditionId, userId, false),
        "Recorded as did not pass after discussion.",
      );
    case "sim-agree":
      return said(
        await simulateBallots(env, auditionId, "agree"),
        "Simulated every director voting **pass**.",
      );
    case "sim-split":
      return said(
        await simulateBallots(env, auditionId, "split"),
        "Simulated a split — one director voted **did not pass**.",
      );
    case "send-confirm":
      return said(
        await sendReviewResult(env, auditionId, userId, note),
        "Sent — they have the result and everyone's feedback.",
      );
    default:
      return { content: "Unhandled action." };
  }
}
