/**
 * `/cycle` (design doc rank 7).
 *
 * Four subcommands: `start` anchors the sequence, `poll` asks the trainees,
 * `schedule` records what was already decided, `close` finishes one.
 */
import { getCoachRoleId, getDirectorIds, isCoach } from "../config/directors";
import { isEnabled } from "../config/flags";
import { getNumber } from "../config/settings";
import { ephemeral, json, modalValue } from "../discord/respond";
import { editOriginalResponse, postToChannelByName, resolveChannelId } from "../discord/rest";
import {
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  MODAL_TEXT_LIMIT,
  TextInputStyle,
  type Interaction,
  type MessagePayload,
} from "../discord/types";
import type { Env } from "../env";
import { bookableSessions, costEstimate, formatMoney } from "./booking";
import {
  DEFAULT_SESSION_END,
  DEFAULT_SESSION_START,
  formatCycleDate,
  type CycleRecord,
} from "./cycle";
import {
  closeCycle,
  bookingWindowCard,
  closePollAndReport,
  lastBooking,
  markBooked,
  currentCycle,
  draftNextCyclePoll,
  cycleCustomId,
  getCycle,
  parseCycleCustomId,
  pollDraftCard,
  pollResultLines,
  postAvailabilityPoll,
  startFromPoll,
  scheduleSummary,
  setCycleFocus,
  setPollDates,
  setSchedule,
  startCycle,
  type CycleAction,
} from "./cycleFlow";

function option(interaction: Interaction, sub: string, name: string): string {
  const subcommand = (interaction.data?.options ?? []).find(
    (o) => (o as { name?: string }).name === sub,
  ) as { options?: { name?: string; value?: unknown }[] } | undefined;
  const found = (subcommand?.options ?? []).find((o) => o.name === name);
  return found?.value === undefined ? "" : String(found.value);
}

function subcommandName(interaction: Interaction): string {
  return ((interaction.data?.options ?? [])[0] as { name?: string } | undefined)?.name ?? "";
}

/** The optional cycle range on /cycle poll and /cycle schedule. */
function declaredDates(interaction: Interaction, sub: string) {
  const startsOn = option(interaction, sub, "starts");
  const endsOn = option(interaction, sub, "ends");
  return startsOn && endsOn ? { startsOn, endsOn } : undefined;
}

function callerId(interaction: Interaction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

export async function handleCycleCommand(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!(await isEnabled(env, "trainee_program"))) {
    return json(ephemeral("The trainee program is switched off."));
  }

  const userId = callerId(interaction);
  if (!userId) return json(ephemeral("Couldn't tell who ran that."));

  const [coachRoleId, directorIds] = await Promise.all([
    getCoachRoleId(env),
    getDirectorIds(env),
  ]);
  if (!isCoach(interaction.member?.roles, coachRoleId, directorIds, userId)) {
    return json(ephemeral("Cycles are set up by coaches and directors."));
  }

  let allowed: string;
  try {
    allowed = await resolveChannelId(env, env.GUILD_DANCE_ID, env.CH_COACHES_CONFIRMATION);
  } catch (err) {
    return json(
      ephemeral(
        `Couldn't find #${env.CH_COACHES_CONFIRMATION}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
  if (interaction.channel_id !== allowed) {
    return json(ephemeral(`Use this in #${env.CH_COACHES_CONFIRMATION}.`));
  }

  // A modal has to be the immediate response, before any deferring.
  if (subcommandName(interaction) === "schedule") {
    const cycle = await currentCycle(env);
    if (!cycle) return json(ephemeral("No cycle on record — run `/cycle start` first."));
    return json(scheduleModal(cycle));
  }

  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        payload = await runSubcommand(env, interaction, subcommandName(interaction), userId);
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
  if (sub === "start") {
    const result = await startCycle(env, userId, {
      startsOn: option(interaction, "start", "starts"),
      endsOn: option(interaction, "start", "ends"),
      focus: option(interaction, "start", "focus") || undefined,
      coachDiscordId: option(interaction, "start", "coach") || undefined,
      choreo: option(interaction, "start", "choreo") || undefined,
    });
    if (!result.ok) return { content: `❌ ${result.reason}` };

    const { cycle } = result;
    return {
      content:
        `📅 **${cycle.name}** is on record — ${formatCycleDate(cycle.startsOn)} to ${formatCycleDate(cycle.endsOn)}.\n` +
        (cycle.focus ? `Focus: **${cycle.focus}**.\n` : "") +
        "Every later cycle follows from this one's end date. I'll offer to line up the next " +
        "one three weeks before it finishes.",
    };
  }

  if (sub === "booked") {
    const cycle = await currentCycle(env);
    if (!cycle) return { content: "\u274c No cycle on record." };

    const leadDays = await getNumber(env, "booking_lead_days");
    const now = new Date();
    const open = bookableSessions(cycle.sessions ?? [], leadDays, now);
    if (open.length === 0) {
      return {
        content:
          "Nothing to book \u2014 every session inside the 30-day window already has a room, " +
          "or none has crossed it yet.",
      };
    }

    await postToChannelByName(
      env,
      env.GUILD_DANCE_ID,
      env.CH_COACHES_CONFIRMATION,
      bookingWindowCard(cycle, open, leadDays, now),
    );
    return { content: `${open.length} session(s) below.` };
  }

  if (sub === "poll-close") {
    const result = await closePollAndReport(env);
    if (!result.ok) return { content: "❌ " + result.reason };
    await postToChannelByName(
      env,
      env.GUILD_DANCE_ID,
      env.CH_COACHES_CONFIRMATION,
      result.card,
    );
    return { content: "Poll closed — the answers are below." };
  }

  if (sub === "close") {
    const result = await closeCycle(env);
    if (!result.ok) return { content: `❌ ${result.reason}` };

    const { cycle } = result;
    return {
      content: [
        `🔒 **${cycle.name}** closed — ${formatCycleDate(cycle.startsOn)} to ${formatCycleDate(cycle.endsOn)}` +
          (cycle.focus ? `, ${cycle.focus}` : "") +
          `, ${cycle.sessions?.length ?? 0} session(s).`,
        "",
        "`/cycle start` or `/cycle poll` will set up the next one.",
        "",
        "_Nothing was counted: attendance totals, completed/skipped counters and any_",
        "_unresolved auditions are rank 11, which needs the Trainees table._",
      ].join("\n"),
    };
  }

  if (sub === "poll") {
    const drafted = await draftNextCyclePoll(env, userId, undefined, declaredDates(interaction, "poll"));
    if (!drafted.ok) return { content: `❌ ${drafted.reason}` };
    await postToChannelByName(
      env,
      env.GUILD_DANCE_ID,
      env.CH_COACHES_CONFIRMATION,
      drafted.card,
    );
    return {
      content:
        `Drafted the poll for **${drafted.cycle.name}** below. Nothing has gone to the ` +
        "trainees yet — tweak the dates and focus first, then post it.",
    };
  }

  return { content: "Unhandled subcommand." };
}

// ------------------------------------------------------------ card buttons

const DATES_INPUT = "dates";

export function cycleComponent(customId: string): ReturnType<typeof parseCycleCustomId> {
  return parseCycleCustomId(customId);
}

export async function handleCycleComponent(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
  action: CycleAction,
  cycleId: string,
  extra?: string,
): Promise<Response> {
  if (!(await isEnabled(env, "trainee_program"))) {
    return json(ephemeral("The trainee program is switched off."));
  }

  const userId = callerId(interaction);
  if (!userId) return json(ephemeral("Couldn't tell who clicked that."));

  const [coachRoleId, directorIds] = await Promise.all([
    getCoachRoleId(env),
    getDirectorIds(env),
  ]);
  if (!isCoach(interaction.member?.roles, coachRoleId, directorIds, userId)) {
    return json(ephemeral("Cycles are set up by coaches and directors."));
  }

  // The date comes from the select, and has to survive into the modal — a
  // modal submit carries no memory of the component that opened it.
  if (action === "book") {
    const cycle = await getCycle(env, cycleId);
    if (!cycle) return json(ephemeral("That cycle is no longer on file."));
    const date = (interaction.data?.values ?? [])[0] ?? "";
    if (!date) return json(ephemeral("Pick a session."));
    return json(bookingModal(cycle, date));
  }

  // Modals have to be the immediate response; they can't follow a defer.
  if (action === "dates" || action === "confirm") {
    const cycle = await getCycle(env, cycleId);
    if (!cycle) return json(ephemeral("That cycle is no longer on file."));
    if (action === "dates") return json(datesModal(cycle));

    const results = cycle.pollResults ?? [];
    if (results.every((r) => r.names.length === 0)) {
      return json(ephemeral("Nobody picked a date, so there's nothing to start from."));
    }
    return json(
      scheduleModal(cycle, pollResultLines(results, `${DEFAULT_SESSION_START}-${DEFAULT_SESSION_END}`)),
    );
  }

  const note =
    modalValue(interaction, DATES_INPUT) || modalValue(interaction, SESSIONS_INPUT);

  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        payload = await runCycleComponent(env, action, cycleId, userId, note, interaction, extra);
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

/**
 * One date per line, ISO. Plain text rather than nine selects because a coach
 * adding a Wednesday needs to type it anyway, and a list you can paste beats a
 * list you have to click.
 */
function datesModal(cycle: CycleRecord): unknown {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: cycleCustomId("dates-save", cycle.cycleId),
      title: `${cycle.name} — poll dates`,
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: DATES_INPUT,
              style: TextInputStyle.PARAGRAPH,
              label: "One per line, YYYY-MM-DD",
              placeholder: "2027-01-02\n2027-01-09\n2027-01-16",
              max_length: MODAL_TEXT_LIMIT,
              required: true,
              value: (cycle.pollDates ?? []).join("\n"),
            },
          ],
        },
      ],
    },
  };
}

/** Stands in for a cycle id when the schedule is about to create one. */
const NEW_CYCLE = "new";

const SESSIONS_INPUT = "sessions";
const STARTS_INPUT = "starts";
const ENDS_INPUT = "ends";

/**
 * One session per line. A textarea rather than a date picker per session,
 * because seven sessions is seven pickers and one paste.
 */
function scheduleModal(cycle: CycleRecord | null, prefill?: string): unknown {
  const existing = prefill ?? (cycle?.sessions ?? [])
    .map((s) => {
      const tail = s.attendees?.length
        ? ` | ${s.attendees.join(", ")}`
        : s.votes !== undefined
          ? ` | ${s.votes}`
          : "";
      return `${s.date} ${s.start}-${s.end}${s.lead ? ` ${s.lead}` : ""}${tail}`;
    })
    .join("\n");

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: cycleCustomId("manual-save", cycle?.cycleId ?? NEW_CYCLE),
      title: `${cycle?.name ?? "New cycle"} — sessions`.slice(0, 45),
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: SESSIONS_INPUT,
              style: TextInputStyle.PARAGRAPH,
              label: "date times lead | who's coming",
              placeholder:
                "2026-09-06 11:00-13:00 Ashna | Mimi, Tay\n2026-09-12 11:00-13:00 Alina | 9",
              max_length: MODAL_TEXT_LIMIT,
              required: true,
              value: existing,
            },
          ],
        },
        // Separate from the sessions because they answer a different question:
        // when the cycle runs, which is usually wider than when it practises.
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: STARTS_INPUT,
              style: TextInputStyle.SHORT,
              label: "Cycle starts (blank = first session)",
              value: cycle?.datesDeclared ? cycle.startsOn : "",
              placeholder: "2026-08-29",
              required: false,
            },
          ],
        },
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: ENDS_INPUT,
              style: TextInputStyle.SHORT,
              label: "Cycle ends (blank = last session)",
              value: cycle?.datesDeclared ? cycle.endsOn : "",
              placeholder: "2026-10-11",
              required: false,
            },
          ],
        },
      ],
    },
  };
}

const BOOK_INPUTS = {
  venue: "venue",
  room: "room",
  type: "venue_type",
  cost: "cost",
} as const;

/**
 * Venue and room prefill from the last booking, per the doc: RISK books the
 * same handful of rooms, and retyping "DL Studio 2" eight times a cycle is
 * eight chances to type it differently.
 */
function bookingModal(cycle: CycleRecord, date: string): unknown {
  const last = lastBooking(cycle);
  const text = (
    id: string,
    label: string,
    value: string,
    placeholder: string,
    required = true,
  ) => ({
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.TEXT_INPUT,
        custom_id: id,
        style: TextInputStyle.SHORT,
        label,
        value,
        placeholder,
        required,
      },
    ],
  });

  return {
    type: InteractionResponseType.MODAL,
    data: {
      // The date rides in the custom_id: a modal submit carries no memory of
      // the select that opened it.
      custom_id: `${cycleCustomId("book-save", cycle.cycleId)}|${date}`,
      title: `Booked — ${formatCycleDate(date)}`.slice(0, 45),
      components: [
        text(BOOK_INPUTS.venue, "Venue", last?.venue ?? "", "DL"),
        text(BOOK_INPUTS.room, "Room", last?.room ?? "", "Studio 2", false),
        text(BOOK_INPUTS.type, "library / studio / free", last?.venueType ?? "library", "library"),
        text(BOOK_INPUTS.cost, "Cost", last ? String(last.cost) : "", "100 — or 0 if free", false),
      ],
    },
  };
}

async function runCycleComponent(
  env: Env,
  action: CycleAction,
  cycleId: string,
  userId: string,
  note: string,
  interaction: Interaction,
  extra?: string,
): Promise<MessagePayload> {
  switch (action) {
    case "begin": {
      const drafted = await draftNextCyclePoll(env, userId, cycleId);
      if (!drafted.ok) return { content: `❌ ${drafted.reason}` };
      await postToChannelByName(
        env,
        env.GUILD_DANCE_ID,
        env.CH_COACHES_CONFIRMATION,
        drafted.card,
      );
      return { content: "Drafted the poll below — nothing has gone to the trainees yet." };
    }

    case "defer":
      return {
        content:
          "Left it for now. I won't ask again about this one — use `/cycle start` when you're ready, " +
          "or I'll offer again three weeks before the cycle after it.",
      };

    case "dates-save": {
      const result = await setPollDates(env, cycleId, note);
      if (!result.ok) return { content: `❌ ${result.reason}` };
      await postToChannelByName(
        env,
        env.GUILD_DANCE_ID,
        env.CH_COACHES_CONFIRMATION,
        pollDraftCard(result.cycle),
      );
      return { content: `Saved ${result.cycle.pollDates?.length} date(s) — redrafted below.` };
    }

    case "focus": {
      const chosen = (interaction.data?.values ?? [])[0] ?? "";
      const result = await setCycleFocus(env, cycleId, chosen);
      if (!result.ok) return { content: `❌ ${result.reason}` };
      await postToChannelByName(
        env,
        env.GUILD_DANCE_ID,
        env.CH_COACHES_CONFIRMATION,
        pollDraftCard(result.cycle),
      );
      return { content: `Focus set to **${chosen}** — redrafted below.` };
    }

    case "manual-save": {
      const result = await setSchedule(
        env,
        cycleId === NEW_CYCLE ? null : cycleId,
        note,
        option(interaction, "schedule", "focus") || undefined,
        (() => {
          const startsOn = modalValue(interaction, STARTS_INPUT).trim();
          const endsOn = modalValue(interaction, ENDS_INPUT).trim();
          return startsOn && endsOn ? { startsOn, endsOn } : undefined;
        })(),
      );
      if (!result.ok) return { content: `❌ ${result.reason}` };
      const { cycle } = result;
      return {
        content: [
          `📅 **${cycle.name}** — ${cycle.sessions?.length} session(s), ${formatCycleDate(cycle.startsOn)} to ${formatCycleDate(cycle.endsOn)}.`,
          "",
          scheduleSummary(cycle),
        ].join("\n"),
      };
    }

    case "close-poll": {
      const result = await closePollAndReport(env, cycleId);
      if (!result.ok) return { content: "\u274c " + result.reason };
      await postToChannelByName(
        env,
        env.GUILD_DANCE_ID,
        env.CH_COACHES_CONFIRMATION,
        result.card,
      );
      return { content: "Poll closed \u2014 the answers are below." };
    }

    case "start-from-poll": {
      const result = await startFromPoll(env, cycleId);
      if (!result.ok) return { content: "\u274c " + result.reason };
      const { cycle } = result;
      return {
        content: [
          `\ud83d\udcc5 **${cycle.name}** started — ${cycle.sessions?.length} session(s), ` +
            `${formatCycleDate(cycle.startsOn)} to ${formatCycleDate(cycle.endsOn)}.`,
          "",
          scheduleSummary(cycle),
          "",
          "_`/cycle schedule` changes the times, leads or who's coming._",
        ].join("\n"),
      };
    }

    case "book-save": {
      const date = extra ?? "";
      const result = await markBooked(env, cycleId, date, userId, {
        venue: modalValue(interaction, BOOK_INPUTS.venue),
        room: modalValue(interaction, BOOK_INPUTS.room),
        venueType: modalValue(interaction, BOOK_INPUTS.type),
        cost: modalValue(interaction, BOOK_INPUTS.cost),
      });
      if (!result.ok) return { content: "\u274c " + result.reason };

      const session = (result.cycle.sessions ?? []).find((s) => s.date === date);
      const booking = session?.booking;
      const each = booking ? costEstimate(booking.cost, session?.votes) : null;
      return {
        content:
          `\ud83c\udfeb **${formatCycleDate(date)}** \u2014 ${booking?.venue}` +
          (booking?.room ? ` ${booking.room}` : "") +
          `, ${formatMoney(booking?.cost ?? 0)}` +
          (each === null ? "." : ` \u00b7 ${formatMoney(each)} each.`),
      };
    }

    case "post": {
      const result = await postAvailabilityPoll(env, cycleId);
      if (!result.ok) return { content: `❌ ${result.reason}` };
      const closes = result.cycle.pollClosesAt
        ? `<t:${Math.floor(new Date(result.cycle.pollClosesAt).getTime() / 1000)}:R>`
        : "soon";
      return {
        content: `🗳️ Posted to #${env.CH_ANNOUNCEMENTS}. It closes ${closes}, and I'll bring the results back here.`,
      };
    }

    default:
      return { content: "Unhandled action." };
  }
}
