import { runAuditionReconcile, handleAuditionSubmit } from "./applications/auditions";
import { runBackstop } from "./applications/backstop";
import {
  buildOpenRowResponse,
  isDecisionAction,
  parseCustomId,
  type CardAction,
} from "./applications/card";
import {
  dueAt,
  getRecord,
  handleFormSubmit,
  headersOk,
  setCardState,
  sheetRowUrl,
} from "./applications/intake";
import { runStaleSweep } from "./applications/stale";
import {
  applyBallot,
  feedbackModalResponse,
  modalFeedbackValue,
  recordFinal,
  saveFeedback,
} from "./applications/vote";
import {
  CONTENT_LIMIT,
  describeTarget,
  EDIT_INPUT_ID,
  parseDraftCustomId,
  type DraftAction,
} from "./drafts/draft";
import {
  approveDraft,
  editAndPublishDraft,
  getDraft,
  skipDraft,
  sweepDrafts,
} from "./drafts/service";
import { ephemeral, json, modalValue } from "./discord/respond";
import { getDirectorIds, isDirector } from "./config/directors";
import { handleFormRegister } from "./commands/formRegister";
import { declineReason } from "./commands/gate";
import { subcommandOf } from "./commands/options";
import { isFormType } from "./config/forms";
import { readApplications, type SheetPage, type SheetRow } from "./appsScript";
import { isEnabled } from "./config/flags";
import { editOriginalResponse } from "./discord/rest";
import { ComponentType, MODAL_TEXT_LIMIT, TextInputStyle } from "./discord/types";
import {
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type Interaction,
  type MessagePayload,
} from "./discord/types";
import { secretsMatch, verifyInteraction } from "./discord/verify";
import type { Env } from "./env";

async function authorizeInbound(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("X-RISK-Secret") ?? "";
  return secretsMatch(header, env.INBOUND_SECRET);
}

/** Reads one row, returning either the row or a message explaining why not. */
async function loadRow(
  env: Env,
  row: number,
): Promise<{ page: SheetPage; sheetRow: SheetRow } | { error: string }> {
  const page = await readApplications(env, { rows: [row] });
  if (!(await headersOk(env, page))) {
    return {
      error:
        "Sheet headers don't match the configured columns — posted to #directors-bot-confirmation.",
    };
  }
  const sheetRow = page.rows.find((r) => r.row === row);
  if (!sheetRow) return { error: `Row ${row} is no longer in the response sheet.` };
  return { page, sheetRow };
}

async function handleOpenRow(env: Env, row: number): Promise<MessagePayload> {
  const loaded = await loadRow(env, row);
  if ("error" in loaded) return { content: loaded.error };
  return buildOpenRowResponse(
    row,
    loaded.page.headers,
    loaded.sheetRow.values,
    sheetRowUrl(env, row),
  );
}

async function handleReopen(env: Env, row: number): Promise<MessagePayload> {
  const record = await getRecord(env, row);
  if (!record) return { content: `No card on record for row ${row}.` };
  if (record.state !== "closed") {
    return { content: `Row ${row} is already \`${record.state}\` — nothing to reopen.` };
  }

  const loaded = await loadRow(env, row);
  if ("error" in loaded) return { content: loaded.error };

  const updated = await setCardState(env, record, "awaiting", loaded.sheetRow, true);
  const due = await dueAt(env, new Date(updated.waitingSince));
  return {
    content: `Reopened row ${row}. The audition-form window restarts and now closes <t:${Math.floor(due.getTime() / 1000)}:D>.`,
  };
}

/**
 * Component clicks must be answered within 3s, but reading the sheet through
 * Apps Script can take longer - so defer, then follow up.
 */
async function respondDeferred(
  env: Env,
  interaction: Interaction,
  action: CardAction,
  row: number,
): Promise<void> {
  let payload: MessagePayload;
  try {
    payload =
      action === "reopen" ? await handleReopen(env, row) : await handleOpenRow(env, row);
  } catch (err) {
    payload = {
      content: `Couldn't ${action} row ${row}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  await editOriginalResponse(env, interaction.application_id, interaction.token, payload);
}

async function runFormRegister(
  env: Env,
  interaction: Interaction,
): Promise<MessagePayload> {
  const sub = subcommandOf(interaction);
  if (!sub || sub.name !== "register") return { content: "Unknown /form subcommand." };

  const type = sub.options.get("type") ?? "";
  const url = sub.options.get("url") ?? "";
  if (!isFormType(type)) return { content: `Unknown form type: \`${type}\`.` };

  return handleFormRegister(env, type, url);
}

async function handleCommand(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
): Promise<Response> {
  if (interaction.data?.name !== "form") {
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unhandled command.", flags: MessageFlags.EPHEMERAL },
    });
  }

  // Layer 3 gating - the real one. Declines are ephemeral.
  const declined = await declineReason(env, interaction, env.CH_DIRECTORS_CONFIRMATION);
  if (declined) {
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: declined, flags: MessageFlags.EPHEMERAL },
    });
  }

  // Opening the form and installing a trigger runs well past the 3s budget.
  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        payload = await runFormRegister(env, interaction);
      } catch (err) {
        payload = {
          content: `Registration failed: ${err instanceof Error ? err.message : String(err)}`,
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

function callerId(interaction: Interaction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

async function applyDecisionAction(
  env: Env,
  action: CardAction,
  row: number,
  userId: string,
): Promise<void> {
  switch (action) {
    case "yes":
    case "no":
    case "hold":
      return applyBallot(env, row, userId, action);
    case "final-yes":
      return recordFinal(env, row, userId, "yes");
    case "final-no":
      return recordFinal(env, row, userId, "no");
    default:
      return;
  }
}

/**
 * Decision clicks are gated on the director roster, then answered with a deferred
 * *update* - the confirmation the director sees is the tally on the card itself.
 */
async function handleDecision(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
  action: CardAction,
  row: number,
): Promise<Response> {
  const directorIds = await getDirectorIds(env);
  if (directorIds.length === 0) {
    return json(
      ephemeral(
        "`config:director_ids` isn't set, so I can't tell who the directors are. Nothing was recorded.",
      ),
    );
  }

  const userId = callerId(interaction);
  if (!userId || !isDirector(directorIds, userId)) {
    return json(ephemeral("Decisions are directors only."));
  }

  // A modal has to be the immediate response; it can't follow a defer.
  if (action === "feedback") {
    const record = await getRecord(env, row);
    return json(feedbackModalResponse(row, record?.decision?.feedback?.[userId]?.text ?? ""));
  }

  ctx.waitUntil(
    applyDecisionAction(env, action, row, userId).catch((err) =>
      console.error("decision failed", action, row, err),
    ),
  );
  return json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
}

function draftEditModal(id: string, content: string): unknown {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `draft|edit-save|${id}`,
      title: "Edit before publishing",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: EDIT_INPUT_ID,
              style: TextInputStyle.PARAGRAPH,
              label: "Message",
              // Modal fields cap at 4000, but a published message caps at 2000.
              max_length: Math.min(MODAL_TEXT_LIMIT, CONTENT_LIMIT),
              required: true,
              value: content.slice(0, CONTENT_LIMIT),
            },
          ],
        },
      ],
    },
  };
}

/**
 * Draft actions answer with a deferred *ephemeral* reply: the draft message
 * itself is repainted separately, and the clicker still gets told what happened
 * (or why nothing did).
 */
async function handleDraftAction(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
  action: DraftAction,
  id: string,
): Promise<Response> {
  const actor = callerId(interaction);
  if (!actor) return json(ephemeral("Couldn't tell who clicked that."));

  // A modal has to be the immediate response; it can't follow a defer.
  if (action === "edit") {
    const draft = await getDraft(env, id);
    if (!draft) return json(ephemeral("That draft is no longer on file."));
    if (draft.state !== "pending") {
      return json(
        ephemeral(`That draft was already ${draft.state === "skipped" ? "skipped" : "published"}.`),
      );
    }
    return json(draftEditModal(id, draft.content));
  }

  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        const result =
          action === "approve"
            ? await approveDraft(env, id, actor)
            : action === "skip"
              ? await skipDraft(env, id, actor)
              : await editAndPublishDraft(env, id, actor, modalValue(interaction, EDIT_INPUT_ID));

        payload = result.ok
          ? {
              content:
                result.draft.state === "skipped"
                  ? "Skipped — nothing was sent or published."
                  : `Delivered to ${describeTarget(result.draft.target)}.`,
            }
          : { content: result.reason };
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

async function handleInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await verifyInteraction(request, env.DISCORD_PUBLIC_KEY);
  if (body === null) return new Response("bad request signature", { status: 401 });

  const interaction = JSON.parse(body) as Interaction;

  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return handleCommand(env, interaction, ctx);
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const draftAction = parseDraftCustomId(interaction.data?.custom_id ?? "");
    if (draftAction) {
      return handleDraftAction(env, interaction, ctx, draftAction.action, draftAction.id);
    }

    const parsed = parseCustomId(interaction.data?.custom_id ?? "");
    if (parsed) {
      if (!(await isEnabled(env, "applications"))) {
        return json(ephemeral("Applications are switched off."));
      }
      if (isDecisionAction(parsed.action)) {
        return handleDecision(env, interaction, ctx, parsed.action, parsed.row);
      }
      ctx.waitUntil(respondDeferred(env, interaction, parsed.action, parsed.row));
      return json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: MessageFlags.EPHEMERAL },
      });
    }
  }

  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    const draftAction = parseDraftCustomId(interaction.data?.custom_id ?? "");
    if (draftAction?.action === "edit-save") {
      return handleDraftAction(env, interaction, ctx, "edit-save", draftAction.id);
    }

    const parsed = parseCustomId(interaction.data?.custom_id ?? "");
    if (parsed?.action === "feedback-save") {
      if (!(await isEnabled(env, "applications"))) {
        return json(ephemeral("Applications are switched off."));
      }
      const userId = callerId(interaction);
      const directorIds = await getDirectorIds(env);
      if (!userId || !isDirector(directorIds, userId)) {
        return json(ephemeral("Feedback is directors only."));
      }
      const text = modalFeedbackValue(interaction);
      ctx.waitUntil(
        saveFeedback(env, parsed.row, userId, text).catch((err) =>
          console.error("saveFeedback failed", parsed.row, err),
        ),
      );
      return json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }
  }

  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Unhandled interaction.", flags: MessageFlags.EPHEMERAL },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }

    if (request.method !== "POST") return new Response("not found", { status: 404 });

    switch (url.pathname) {
      case "/interactions":
        return handleInteraction(request, env, ctx);

      case "/hooks/application-submit": {
        if (!(await authorizeInbound(request, env))) {
          return new Response("unauthorized", { status: 401 });
        }
        const { row } = (await request.json()) as { row?: number };
        if (typeof row !== "number" || row < 2) {
          return json({ ok: false, error: "row must be a number >= 2" }, 400);
        }
        // Ack immediately; Apps Script triggers have a short leash.
        ctx.waitUntil(
          handleFormSubmit(env, row).catch((err) =>
            console.error("handleFormSubmit failed", row, err),
          ),
        );
        return json({ ok: true, accepted: row });
      }

      case "/hooks/audition-submit": {
        if (!(await authorizeInbound(request, env))) {
          return new Response("unauthorized", { status: 401 });
        }
        const { row } = (await request.json()) as { row?: number };
        if (typeof row !== "number" || row < 2) {
          return json({ ok: false, error: "row must be a number >= 2" }, 400);
        }
        ctx.waitUntil(
          handleAuditionSubmit(env, row).catch((err) =>
            console.error("handleAuditionSubmit failed", row, err),
          ),
        );
        return json({ ok: true, accepted: row });
      }

      case "/jobs/drafts-sweep": {
        if (!(await authorizeInbound(request, env))) {
          return new Response("unauthorized", { status: 401 });
        }
        return json({ ok: true, ...(await sweepDrafts(env)) });
      }

      case "/jobs/applications-daily": {
        if (!(await authorizeInbound(request, env))) {
          return new Response("unauthorized", { status: 401 });
        }
        // Order matters. Backstop first, so a row that was never carded gets its
        // card. Then reconcile auditions, so anyone who submitted is off
        // `awaiting`. Only then does the sweep decide what has run out of time.
        const backstop = await runBackstop(env);
        const auditions = await runAuditionReconcile(env);
        const stale = await runStaleSweep(env);
        return json({ ok: true, backstop, auditions, stale });
      }

      default:
        return new Response("not found", { status: 404 });
    }
  },
};
