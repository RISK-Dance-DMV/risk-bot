/**
 * Interviews (design doc rank 24).
 *
 *   [Interview] -> modal prefilled with their stated availability, you enter a
 *   time -> draft -> status interview-offered -> when they reply and it's
 *   booked, a director clicks [Interview Confirmed] -> Apps Script creates the
 *   calendar event and invites them -> interview-scheduled.
 *
 * The invite goes through Apps Script, not the service account: service accounts
 * can't add guests without domain-wide delegation.
 */
import { createInterviewEvent } from "../appsScript";
import { CARD_COLUMNS, PINNED } from "../config/columns";
import { isEnabled } from "../config/flags";
import { getInterviewGuests, getTimeZone } from "../config/settings";
import { ComponentType, InteractionResponseType, TextInputStyle, type Interaction, type MessagePayload } from "../discord/types";
import { modalValue } from "../discord/respond";
import type { Env } from "../env";
import { registerPublishHook } from "../drafts/hooks";
import { describeConfirmation } from "../drafts/draft";
import { createDraft } from "../drafts/service";
import type { Draft } from "../drafts/draft";
import { renderForSend } from "../email/service";
import { isDecidable } from "./card";
import { cell, parseRow } from "./fields";
import { getRecord, putRecord, refreshCard, type CardRecord } from "./intake";
import {
  DEFAULT_MINUTES,
  formatSlot,
  slotInstant,
  validateSlot,
  type InterviewRecord,
} from "./interviewSlot";

export const INTERVIEW_TEMPLATE_KEY = "interview invitation";

// --------------------------------------------------------------- the modal

const INPUTS = {
  availability: "availability",
  date: "date",
  time: "time",
  duration: "duration",
  note: "note",
} as const;

/** Five top-level components is the cap, and this uses all five. */
export function interviewModalResponse(
  row: number,
  availability: string,
  existing?: InterviewRecord,
): unknown {
  const text = (
    id: string,
    label: string,
    style: number,
    required: boolean,
    value = "",
    placeholder?: string,
  ) => ({
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.TEXT_INPUT,
        custom_id: id,
        style,
        label,
        required,
        value: value.slice(0, 1000),
        ...(placeholder ? { placeholder } : {}),
      },
    ],
  });

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `app|interview-save|${row}`,
      title: "Draft an interview invitation",
      components: [
        text(
          INPUTS.availability,
          "They said they're free (reference only)",
          TextInputStyle.PARAGRAPH,
          false,
          availability || "—",
        ),
        text(INPUTS.date, "Date", TextInputStyle.SHORT, true, existing?.date ?? "", "2026-09-20"),
        text(INPUTS.time, "Start time (24h)", TextInputStyle.SHORT, true, existing?.time ?? "", "14:30"),
        text(
          INPUTS.duration,
          "Minutes",
          TextInputStyle.SHORT,
          false,
          existing ? String(existing.durationMinutes) : String(DEFAULT_MINUTES),
        ),
        text(INPUTS.note, "Anything to add to the invitation", TextInputStyle.PARAGRAPH, false),
      ],
    },
  };
}

/** Builds the modal for a row, prefilled with whatever they said they were free for. */
export async function interviewModalFor(env: Env, row: number): Promise<unknown> {
  const record = await getRecord(env, row);
  const column = CARD_COLUMNS.find((c) => c.key === "availability")?.column ?? null;
  const availability = record?.values ? cell(record.values, column) : "";
  return interviewModalResponse(row, availability, record?.interview);
}

/**
 * The time they actually agreed to, which is often not the one you offered.
 * Prefilled with the offered slot so confirming an unchanged time is three taps.
 */
export async function confirmModalFor(env: Env, row: number): Promise<unknown> {
  const record = await getRecord(env, row);
  const interview = record?.interview;

  const field = (id: string, label: string, value: string, placeholder: string) => ({
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.TEXT_INPUT,
        custom_id: id,
        style: TextInputStyle.SHORT,
        label,
        required: id !== INPUTS.duration,
        value,
        placeholder,
      },
    ],
  });

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `app|interview-confirm-save|${row}`,
      title: "Confirm the interview time",
      components: [
        field(INPUTS.date, "Date actually booked", interview?.date ?? "", "2026-09-20"),
        field(INPUTS.time, "Start time (24h)", interview?.time ?? "", "14:30"),
        field(
          INPUTS.duration,
          "Minutes",
          String(interview?.durationMinutes ?? DEFAULT_MINUTES),
          String(DEFAULT_MINUTES),
        ),
      ],
    },
  };
}

export function readInterviewModal(interaction: Interaction): {
  date: string;
  time: string;
  duration: string;
  note: string;
} {
  return {
    date: modalValue(interaction, INPUTS.date),
    time: modalValue(interaction, INPUTS.time),
    duration: modalValue(interaction, INPUTS.duration),
    note: modalValue(interaction, INPUTS.note).trim(),
  };
}

// ------------------------------------------------------------------ flow

async function loadDecidable(env: Env, row: number): Promise<CardRecord | null> {
  const record = await getRecord(env, row);
  if (!record || !record.values || !isDecidable(record.state)) return null;
  return record;
}

/** [Interview] — drafts the invitation. Sends nothing on its own. */
export async function draftInterview(
  env: Env,
  row: number,
  userId: string,
  input: { date: string; time: string; duration: string; note: string },
): Promise<MessagePayload> {
  const record = await loadDecidable(env, row);
  if (!record?.values) return { content: `Row ${row} isn't open for interviews.` };

  const slot = validateSlot(input.date, input.time, input.duration);
  if (!slot.ok) return { content: `❌ ${slot.reason}` };

  const application = parseRow(row, record.values);
  const email = cell(record.values, PINNED.email);
  if (!email) return { content: `No email on row ${row}, so there's nobody to invite.` };

  const rendered = await renderForSend(env, INTERVIEW_TEMPLATE_KEY, {
    name: application.name || "there",
    slot: formatSlot(slot.date, slot.time),
  });
  if (!rendered.ok) return { content: `❌ ${rendered.reason}` };

  // The note is appended rather than merged, so a template with no {{note}}
  // field still works and a blank note doesn't count as unfilled.
  const body = input.note ? `${rendered.body}\n\n${input.note}` : rendered.body;

  const draft = await createDraft(env, {
    kind: INTERVIEW_TEMPLATE_KEY,
    content: body,
    target: { kind: "email", to: email, subject: rendered.subject },
    confirmation: { guild: "community", channel: env.CH_AUDITION_REVIEW },
    confirmationChannelId: record.threadId,
    referencesAt: slotInstant(slot.date, slot.time, await getTimeZone(env)).toISOString(),
    meta: { hook: "interview-offer", row: String(row) },
  });
  if (!draft.ok) return { content: `❌ ${draft.reason}` };

  const interview: InterviewRecord = {
    state: "drafted",
    date: slot.date,
    time: slot.time,
    durationMinutes: slot.durationMinutes,
    ...(input.note ? { note: input.note } : {}),
    draftedBy: userId,
    draftedAt: new Date().toISOString(),
    draftId: draft.draft.id,
  };
  const updated: CardRecord = { ...record, interview };
  await putRecord(env, updated);
  await refreshCard(env, updated);

  return {
    content: `Drafted an invitation for ${formatSlot(slot.date, slot.time)}. **Nothing has been offered yet** — approve the draft ${describeConfirmation(draft.draft, record.threadId)} to send it.`,
  };
}

/** Runs when the invitation draft is actually published. */
export async function onInterviewOfferPublished(env: Env, draft: Draft): Promise<void> {
  const row = Number(draft.meta?.row);
  if (!Number.isFinite(row)) return;

  const record = await getRecord(env, row);
  // Ignore a stale draft: the interview may have been redrafted since.
  if (!record?.interview || record.interview.draftId !== draft.id) return;

  const updated: CardRecord = {
    ...record,
    interview: {
      ...record.interview,
      state: "offered",
      offeredAt: new Date().toISOString(),
    },
  };
  await putRecord(env, updated);
  await refreshCard(env, updated);
}

registerPublishHook("interview-offer", onInterviewOfferPublished);

/**
 * [Interview Confirmed] — creates the event and invites them, at the time they
 * actually agreed to, which need not be the one that was offered.
 */
export async function confirmInterview(
  env: Env,
  row: number,
  userId: string,
  input: { date: string; time: string; duration: string },
): Promise<MessagePayload> {
  const record = await loadDecidable(env, row);
  if (!record?.interview) return { content: `No interview drafted for row ${row}.` };

  const interview = record.interview;
  if (interview.state === "drafted") {
    return {
      content: "That invitation hasn't been sent yet — approve the draft first.",
    };
  }
  if (interview.state === "scheduled") {
    return { content: "That interview is already scheduled." };
  }

  // "While email_sends is off, [Interview Confirmed] does not advance the
  // status" - the invite emails them, so nothing is recorded either.
  if (!(await isEnabled(env, "email_sends"))) {
    return {
      content:
        "`features.email_sends` is off. The calendar invite would email them, so nothing was created and the status stays `interview-offered`.",
    };
  }

  const slot = validateSlot(input.date, input.time, input.duration);
  if (!slot.ok) return { content: `❌ ${slot.reason}` };

  const application = record.values ? parseRow(row, record.values) : null;
  const email = record.values ? cell(record.values, PINNED.email) : "";
  if (!email) return { content: `No email on row ${row}, so there's nobody to invite.` };

  const [timeZone, guests] = await Promise.all([
    getTimeZone(env),
    getInterviewGuests(env),
  ]);

  let event;
  try {
    event = await createInterviewEvent(env, {
      // Resolved here so the event lands on the crew's clock rather than on
      // whatever timezone the Apps Script project happens to be set to.
      startsAt: slotInstant(slot.date, slot.time, timeZone).toISOString(),
      date: slot.date,
      time: slot.time,
      durationMinutes: slot.durationMinutes,
      guestEmail: email,
      guests,
      title: `RISK interview — ${application?.name || `row ${row}`}`,
      description: interview.note ?? "",
    });
  } catch (err) {
    return {
      content: `❌ Couldn't create the event: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const moved = slot.date !== interview.date || slot.time !== interview.time;
  const updated: CardRecord = {
    ...record,
    interview: {
      ...interview,
      state: "scheduled",
      date: slot.date,
      time: slot.time,
      durationMinutes: slot.durationMinutes,
      ...(moved ? { rescheduledFrom: { date: interview.date, time: interview.time } } : {}),
      confirmedBy: userId,
      confirmedAt: new Date().toISOString(),
      eventId: event.eventId,
    },
  };
  await putRecord(env, updated);
  await refreshCard(env, updated);

  const note = moved
    ? ` — moved from the ${formatSlot(interview.date, interview.time)} you offered`
    : "";
  return {
    content: `Scheduled for ${formatSlot(slot.date, slot.time)} ${timeZone} — invited \`${email}\`${guests.length ? ` and ${guests.length} of us` : ""}${note}.`,
  };
}
