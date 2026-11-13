import { runAuditionReconcile, handleAuditionSubmit } from "./applications/auditions";
import { runBackstop } from "./applications/backstop";
import { runFormReview } from "./applications/formReview";
import {
  isDirectorAction,
  parseCustomId,
  VOTE_NONE,
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
import {
  confirmInterview,
  confirmModalFor,
  draftInterview,
  interviewModalFor,
  readInterviewModal,
} from "./applications/interview";
import {
  beginOutcome,
  completeOutcome,
  needsPlacement,
  outcomeFeedbackModal,
  readOutcomeModal,
  revealOutcomes,
  setPlacement,
} from "./applications/outcome";
import { draftReply, readReplyModal, replyModalFor } from "./applications/reply";
import { isSubunit, openSpot, runWaitlistRevisit } from "./applications/waitlist";
import { runStaleSweep } from "./applications/stale";
import {
  applyBallot,
  feedbackModalResponse,
  modalFeedbackValue,
  recordFinal,
  recordFinalPlacement,
  rejectAfterDiscussion,
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
  saveDraftEdit,
  getDraft,
  skipDraft,
  sweepDrafts,
} from "./drafts/service";
import { ephemeral, json, modalValue } from "./discord/respond";
import { getDirectorIds, isDirector } from "./config/directors";
import { runAuditionDeadlines } from "./trainees/auditionFlow";
import {
  runBookingWindow,
  runCyclePrompt,
  runPollClose,
  runAuditionsOpen,
  runSessionReminders,
} from "./cycles/cycleFlow";
import {
  cycleComponent,
  handleCycleCommand,
  handleCycleComponent,
} from "./cycles/cycleHandlers";
import {
  auditionComponent,
  handleAuditionCommand,
  handleAuditionComponent,
} from "./trainees/auditionHandlers";
import {
  diamondsComponent,
  handleDiamondsCommand,
  handleDiamondsComponent,
} from "./diamonds/handlers";
import { runDiamondsDaily } from "./diamonds/flow";
import { runPieceReview } from "./diamonds/pieceReview";
import { CARD_COLUMNS } from "./config/columns";
import { presumedPlacement } from "./config/subunits";
import { cell } from "./applications/fields";
import { handleFormRegister } from "./commands/formRegister";
import { declineReason } from "./commands/gate";
import { subcommandOf } from "./commands/options";
import { isFormType } from "./config/forms";
import { readApplications, type SheetPage, type SheetRow } from "./appsScript";
import { isEnabled } from "./config/flags";
import { alertDirectors, editOriginalResponse, followUp } from "./discord/rest";
import { ComponentType, MODAL_TEXT_LIMIT, TextInputStyle } from "./discord/types";
import {
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type Interaction,
  type MessagePayload,
} from "./discord/types";
import { diagnoseSecret, verifyInteraction } from "./discord/verify";
import type { Env } from "./env";

/**
 * Inbound job and webhook auth. On failure it says why in terms the caller can
 * act on, without disclosing either secret.
 */
function authorizeInbound(request: Request, env: Env): Response | null {
  const header = request.headers.get("X-RISK-Secret") ?? "";
  const problem = diagnoseSecret(header, env.INBOUND_SECRET ?? "");
  return problem ? new Response(`unauthorized: ${problem}`, { status: 401 }) : null;
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

async function handleReopen(env: Env, row: number): Promise<MessagePayload> {
  const record = await getRecord(env, row);
  if (!record) return { content: `No card on record for row ${row}.` };
  if (record.state !== "closed") {
    return { content: `Row ${row} is already \`${record.state}\` — nothing to reopen.` };
  }

  const loaded = await loadRow(env, row);
  if ("error" in loaded) return { content: loaded.error };

  // A card closed by its outcome goes back to whatever it was, with its clock
  // untouched — there is no audition-form window to restart, and restarting one
  // would have the sweep close it again in a fortnight.
  if (record.closedFrom) {
    await setCardState(env, record, record.closedFrom, loaded.sheetRow);
    return {
      content: `Reopened row ${row} as \`${record.closedFrom}\`. The outcome that was sent still stands on the card.`,
    };
  }

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
    payload = await handleReopen(env, row);
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

async function runWaitlistOpen(
  env: Env,
  interaction: Interaction,
): Promise<MessagePayload> {
  const sub = subcommandOf(interaction);
  if (!sub || sub.name !== "open") return { content: "Unknown /waitlist subcommand." };

  const subunit = sub.options.get("subunit") ?? "";
  if (!isSubunit(subunit)) return { content: `Unknown subunit: \`${subunit}\`.` };

  return openSpot(env, subunit);
}

async function handleCommand(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
): Promise<Response> {
  const name = interaction.data?.name;

  // Rank 12 lives in the dance guild and is trainee-facing, so it does its own
  // gating: the channel allowlist is #trainee-bot and the roster is coaches,
  // neither of which declineReason knows about.
  if (name === "audition") return handleAuditionCommand(env, interaction, ctx);
  if (name === "cycle") return handleCycleCommand(env, interaction, ctx);
  // Diamonds does its own gating too, and for a third set of reasons: the
  // channel is #diamonds-bot, five of the subcommands are for the people
  // auditioning, and the other five are directors only.
  if (name === "diamonds") return handleDiamondsCommand(env, interaction, ctx);

  if (name !== "form" && name !== "waitlist") {
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unhandled command.", flags: MessageFlags.EPHEMERAL },
    });
  }

  // /waitlist is about applicants, so it belongs where the cards are.
  const channel =
    name === "waitlist" ? env.CH_AUDITION_REVIEW : env.CH_DIRECTORS_CONFIRMATION;

  // Layer 3 gating - the real one. Declines are ephemeral.
  const declined = await declineReason(env, interaction, channel);
  if (declined) {
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: declined, flags: MessageFlags.EPHEMERAL },
    });
  }

  // Opening a form, installing a trigger, or scanning every card all run well
  // past the 3s budget.
  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        payload =
          name === "waitlist"
            ? await runWaitlistOpen(env, interaction)
            : await runFormRegister(env, interaction);
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

function callerId(interaction: Interaction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

async function applyDecisionAction(
  env: Env,
  interaction: Interaction,
  action: CardAction,
  row: number,
  userId: string,
): Promise<void> {
  switch (action) {
    case "hold":
      return applyBallot(env, row, userId, "hold");
    case "vote": {
      // "None" is an explicit no, so it wins over anything picked alongside it.
      const chosen = interaction.data?.values ?? [];
      const subunits = chosen.includes(VOTE_NONE)
        ? []
        : chosen.filter((v) => v !== VOTE_NONE);
      return applyBallot(env, row, userId, subunits);
    }
    case "final-yes":
      return recordFinal(env, row, userId, "yes");
    case "skip-interview":
      return revealOutcomes(env, row);
    default:
      return;
  }
}

/**
 * Actions that answer the clicker in words rather than just redrawing the card.
 * Returns null for the ones whose confirmation *is* the redrawn card.
 */
async function spokenAction(
  env: Env,
  interaction: Interaction,
  action: CardAction,
  row: number,
  userId: string,
): Promise<(() => Promise<MessagePayload>) | null> {
  switch (action) {
    case "interview-save":
      return () => draftInterview(env, row, userId, readInterviewModal(interaction));
    case "interview-confirm-save":
      return () => confirmInterview(env, row, userId, readInterviewModal(interaction));
    case "outcome-save":
      return () => completeOutcome(env, row, userId, readOutcomeModal(interaction));
    case "reply-save":
      return () => draftReply(env, row, readReplyModal(interaction));
    default:
      return null;
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

  // Modals have to be the immediate response; they can't follow a defer.
  if (action === "feedback") {
    const record = await getRecord(env, row);
    return json(feedbackModalResponse(row, record?.decision?.feedback?.[userId]?.text ?? ""));
  }
  if (action === "interview") {
    return json(await interviewModalFor(env, row));
  }
  if (action === "interview-confirm") {
    return json(await confirmModalFor(env, row));
  }
  if (action === "reply") {
    return json(await replyModalFor(env, row));
  }

  // The placement a discussion landed on. Recorded straight away, because the
  // card it came from is about to stop offering it.
  if (action === "final-placement") {
    const chosen = interaction.data?.values ?? [];
    if (chosen.length === 0) {
      return json(ephemeral("Pick at least one subunit, or use Reject from RISK."));
    }
    ctx.waitUntil(
      recordFinalPlacement(env, row, userId, chosen).catch((err) =>
        console.error("final placement failed", row, err),
      ),
    );
    return json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  // Rejecting after a discussion settles the split and opens the rejection in
  // one move — the decision and telling them are the same act.
  if (action === "final-no") {
    const updated = await rejectAfterDiscussion(env, row, userId);
    if (!updated) return json(ephemeral(`Row ${row} isn't open for decisions.`));
    return json(outcomeFeedbackModal(row, updated, directorIds));
  }

  // The three outcome buttons open a short flow rather than acting immediately:
  // placement (unless it's a rejection), then the feedback the applicant reads.
  if (
    action === "outcome-welcome" ||
    action === "outcome-reject" ||
    action === "outcome-waitlist"
  ) {
    const outcome =
      action === "outcome-welcome"
        ? "welcomed"
        : action === "outcome-reject"
          ? "rejected"
          : "waitlisted";

    // A rejection needs no placement, so it goes straight to composing the
    // message — and a modal has to be the immediate response, so that one is
    // paid for synchronously.
    if (!needsPlacement(outcome)) {
      const begun = await beginOutcome(env, row, userId, outcome);
      return begun.snoozed
        ? json(ephemeral(begun.message.content ?? "Done."))
        : json(outcomeFeedbackModal(row, begun.record, directorIds));
    }

    // Everything else acknowledges first. beginOutcome reads KV three times and
    // repaints the card over the Discord API; doing that before answering can
    // overrun the 3s budget, and a blown budget looks exactly like the button
    // doing nothing.
    ctx.waitUntil(
      (async () => {
        const begun = await beginOutcome(env, row, userId, outcome);
        if (begun.snoozed) {
          await followUp(env, interaction.application_id, interaction.token, {
            content: begun.message.content ?? "Done.",
            flags: MessageFlags.EPHEMERAL,
          });
        }
      })().catch((err) => console.error("beginOutcome failed", outcome, row, err)),
    );
    return json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  // Keeping the seeded placement. The select can't express "unchanged", so the
  // button says it instead.
  if (action === "placement-confirm") {
    const record = await getRecord(env, row);
    if (!record?.values) return json(ephemeral(`Row ${row} isn't on file.`));

    const column = CARD_COLUMNS.find((c) => c.key === "subunits")?.column ?? null;
    const presumed = presumedPlacement(cell(record.values, column), record.pending?.subunits);
    if (presumed.length === 0) {
      return json(ephemeral("There's more than one option here — pick from the menu."));
    }

    // Written through setPlacement rather than trusting whatever was seeded, so
    // the recorded placement and the button's label can't drift apart.
    const updated = await setPlacement(env, row, presumed);
    if (!updated) {
      return json(ephemeral("That decision timed out — press the button again."));
    }
    return json(outcomeFeedbackModal(row, updated, directorIds));
  }

  // Placement chosen — the select's own interaction opens the feedback modal.
  if (action === "placement") {
    const chosen = interaction.data?.values ?? [];
    const updated = await setPlacement(env, row, chosen);
    if (!updated) {
      return json(ephemeral("That decision timed out — press the button again."));
    }
    return json(outcomeFeedbackModal(row, updated, directorIds));
  }

  // These can fail in ways worth reading — a bad date, a missing template — so
  // they answer with a message rather than only redrawing the card.
  const spoken = await spokenAction(env, interaction, action, row, userId);
  if (spoken) {
    ctx.waitUntil(
      (async () => {
        let payload: MessagePayload;
        try {
          payload = await spoken();
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

  ctx.waitUntil(
    applyDecisionAction(env, interaction, action, row, userId).catch((err) =>
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
      title: "Edit draft — saves, doesn't send",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: EDIT_INPUT_ID,
              style: TextInputStyle.PARAGRAPH,
              label: "Message (approve separately to send)",
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
              : await saveDraftEdit(env, id, actor, modalValue(interaction, EDIT_INPUT_ID));

        payload = result.ok
          ? {
              content:
                result.draft.state === "skipped"
                  ? "Skipped — nothing was sent or published."
                  : action === "edit-save"
                    ? `Saved. **Still not sent** — click Approve when it reads right.`
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

    const audition = auditionComponent(interaction.data?.custom_id ?? "");
    if (audition) {
      return handleAuditionComponent(
        env,
        interaction,
        ctx,
        audition.action,
        audition.auditionId,
      );
    }

    const diamonds = diamondsComponent(interaction.data?.custom_id ?? "");
    if (diamonds) {
      return handleDiamondsComponent(
        env,
        interaction,
        ctx,
        diamonds.action,
        diamonds.arg,
      );
    }

    const cycle = cycleComponent(interaction.data?.custom_id ?? "");
    if (cycle) {
      return handleCycleComponent(
        env,
        interaction,
        ctx,
        cycle.action,
        cycle.cycleId,
        cycle.extra,
      );
    }

    const parsed = parseCustomId(interaction.data?.custom_id ?? "");
    if (parsed) {
      if (!(await isEnabled(env, "applications"))) {
        return json(ephemeral("Applications are switched off."));
      }
      if (isDirectorAction(parsed.action)) {
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
    const audition = auditionComponent(interaction.data?.custom_id ?? "");
    if (audition) {
      return handleAuditionComponent(
        env,
        interaction,
        ctx,
        audition.action,
        audition.auditionId,
      );
    }

    const diamonds = diamondsComponent(interaction.data?.custom_id ?? "");
    if (diamonds) {
      return handleDiamondsComponent(
        env,
        interaction,
        ctx,
        diamonds.action,
        diamonds.arg,
      );
    }

    const cycle = cycleComponent(interaction.data?.custom_id ?? "");
    if (cycle) {
      return handleCycleComponent(env, interaction, ctx, cycle.action, cycle.cycleId);
    }

    const draftAction = parseDraftCustomId(interaction.data?.custom_id ?? "");
    if (draftAction?.action === "edit-save") {
      return handleDraftAction(env, interaction, ctx, "edit-save", draftAction.id);
    }

    const parsed = parseCustomId(interaction.data?.custom_id ?? "");
    if (parsed) {
      if (!(await isEnabled(env, "applications"))) {
        return json(ephemeral("Applications are switched off."));
      }
      if (
        parsed.action === "interview-save" ||
        parsed.action === "interview-confirm-save" ||
        parsed.action === "outcome-save" ||
        parsed.action === "reply-save"
      ) {
        return handleDecision(env, interaction, ctx, parsed.action, parsed.row);
      }
      if (parsed.action === "feedback-save") {
        const userId = callerId(interaction);
        const directorIds = await getDirectorIds(env);
        if (!userId || !isDirector(directorIds, userId)) {
          return json(ephemeral("Feedback is directors only."));
        }
        ctx.waitUntil(
          saveFeedback(env, parsed.row, userId, modalFeedbackValue(interaction)).catch((err) =>
            console.error("saveFeedback failed", parsed.row, err),
          ),
        );
        return json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
      }
    }
  }

  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Unhandled interaction.", flags: MessageFlags.EPHEMERAL },
  });
}

/**
 * Runs a batch of cron jobs, reporting what each one did or why it failed.
 *
 * Each is isolated: the backstop failing shouldn't stop the waitlist sweep. But
 * the response is still a 500 if anything failed, so a broken morning shows up
 * as a red workflow rather than a green one full of errors nobody reads.
 */
async function runJobs(
  env: Env,
  jobs: [string, () => Promise<unknown>][],
): Promise<Response> {
  const results: Record<string, unknown> = {};
  const failures: string[] = [];

  for (const [name, run] of jobs) {
    try {
      results[name] = await run();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results[name] = { error: reason };
      failures.push(`${name}: ${reason}`);
      console.error("job failed", name, err);
    }
  }

  if (failures.length > 0) {
    await alertDirectors(
      env,
      [`**${failures.length} daily job(s) failed.**`, ...failures.map((f) => `• ${f}`)].join(
        "\n",
      ),
    );
  }

  return json({ ok: failures.length === 0, ...results }, failures.length > 0 ? 500 : 200);
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
        const denied = authorizeInbound(request, env);
        if (denied) return denied;
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
        const denied = authorizeInbound(request, env);
        if (denied) return denied;
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

      case "/jobs/trainee-daily": {
        const denied = authorizeInbound(request, env);
        if (denied) return denied;
        // Kept off /jobs/applications-daily: that one is about applicants and
        // this one is about trainees, and a failure in either shouldn't be
        // reported as the other having gone wrong.
        return runJobs(env, [
          ["audition deadlines", () => runAuditionDeadlines(env)],
          ["cycle prompt", () => runCyclePrompt(env)],
          ["poll close", () => runPollClose(env)],
          ["booking window", () => runBookingWindow(env)],
          ["session reminders", () => runSessionReminders(env)],
          ["auditions open", () => runAuditionsOpen(env)],
        ]);
      }

      case "/jobs/diamonds-daily": {
        const denied = authorizeInbound(request, env);
        if (denied) return denied;
        // Its own endpoint rather than a line in trainee-daily: the Diamonds
        // audition isn't the trainee program, and a Diamonds reminder failing
        // shouldn't be reported as a trainee deadline having gone wrong.
        return runJobs(env, [
          ["diamonds", () => runDiamondsDaily(env)],
          // The sweep above is about records — windows closing, clocks running
          // out. This is the other kind: a date in the year telling the two of
          // them to change the group piece, which is why it's a job of its own
          // rather than another counter on the sweep.
          ["piece review", () => runPieceReview(env)],
        ]);
      }

      case "/jobs/drafts-sweep": {
        const denied = authorizeInbound(request, env);
        if (denied) return denied;
        return runJobs(env, [["drafts", () => sweepDrafts(env)]]);
      }

      case "/jobs/applications-daily": {
        const denied = authorizeInbound(request, env);
        if (denied) return denied;
        // Order matters. Backstop first, so a row that was never carded gets its
        // card. Then reconcile auditions, so anyone who submitted is off
        // `awaiting`. Only then does the sweep decide what has run out of time.
        return runJobs(env, [
          ["backstop", () => runBackstop(env)],
          ["auditions", () => runAuditionReconcile(env)],
          ["stale", () => runStaleSweep(env)],
          ["waitlist", () => runWaitlistRevisit(env)],
          // Last, and unrelated to the rest: the others are about rows that
          // arrived, this one is a date in the year telling the directors to
          // look at the forms those rows come from.
          ["form review", () => runFormReview(env)],
        ]);
      }

      default:
        return new Response("not found", { status: 404 });
    }
  },
};
