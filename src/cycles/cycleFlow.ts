/**
 * Cycle records and the prompt that starts the next one (design doc rank 7).
 *
 * Records live in KV, same as auditions and application cards. The doc's system
 * of record is the Cycles tab of the RISK Training Program sheet, which doesn't
 * exist yet; when it does, this moves and KV goes back to being markers.
 */
import { getNumber } from "../config/settings";
import { isEnabled } from "../config/flags";
import {
  expirePoll,
  getMessage,
  pollAnswerVoters,
  postToChannelByName,
} from "../discord/rest";
import { ButtonStyle, ComponentType, type MessagePayload } from "../discord/types";
import type { Env } from "../env";
import {
  bookableSessions,
  daysWaiting,
  validateBooking,
  type BookingInput,
  type SessionBooking,
} from "./booking";
import { dueReminders } from "./reminders";
import {
  cycleIdFor,
  cycleName,
  auditionWindow,
  cycleRangeFor,
  DEFAULT_SESSION_END,
  DEFAULT_SESSION_START,
  CYCLE_FOCUSES,
  formatCycleDate,
  isCycleFocus,
  needsNextCyclePrompt,
  nextBlockAfter,
  parseIsoDate,
  parseSessionLines,
  sessionSpan,
  saturdaysBetween,
  validateCycleDates,
  type CycleRecord,
  type CycleSession,
} from "./cycle";

const RECORD_PREFIX = "cycle:rec:";
const CURRENT_KEY = "cycle:current";
/** Long enough that a finished cycle is still readable a year later. */
const CYCLE_TTL = 400 * 24 * 60 * 60;

const recordKey = (cycleId: string) => `${RECORD_PREFIX}${cycleId}`;

export async function getCycle(env: Env, cycleId: string): Promise<CycleRecord | null> {
  return env.KV.get<CycleRecord>(recordKey(cycleId), "json");
}

export async function putCycle(env: Env, cycle: CycleRecord): Promise<void> {
  await env.KV.put(recordKey(cycle.cycleId), JSON.stringify(cycle), {
    expirationTtl: CYCLE_TTL,
  });
}

/** The cycle everything else is relative to. */
export async function currentCycle(env: Env): Promise<CycleRecord | null> {
  const id = await env.KV.get(CURRENT_KEY);
  return id ? getCycle(env, id) : null;
}

export async function setCurrentCycle(env: Env, cycleId: string): Promise<void> {
  await env.KV.put(CURRENT_KEY, cycleId, { expirationTtl: CYCLE_TTL });
}

export type CycleResult = { ok: true; cycle: CycleRecord } | { ok: false; reason: string };

// ------------------------------------------------------------- the bootstrap

export interface StartCycleInput {
  startsOn: string;
  endsOn: string;
  focus?: string;
  coachDiscordId?: string;
  choreo?: string;
}

/**
 * `/cycle start` — records the cycle that is already running.
 *
 * Deliberately a command rather than something computed. Every later cycle is
 * derived from this one's end date, so the sequence needs one honest anchor,
 * and the cycle RISK is in now doesn't fit the two-month grid.
 */
export async function startCycle(
  env: Env,
  userId: string,
  input: StartCycleInput,
): Promise<CycleResult> {
  const dates = validateCycleDates(input.startsOn, input.endsOn);
  if (!dates.ok) return { ok: false, reason: dates.reason };

  if (input.focus && !isCycleFocus(input.focus)) {
    return { ok: false, reason: `"${input.focus}" isn't one of the five focuses.` };
  }

  const existing = await currentCycle(env);
  if (existing && existing.status !== "closed") {
    return {
      ok: false,
      reason:
        `**${existing.name}** is already running (${formatCycleDate(existing.startsOn)} – ` +
        `${formatCycleDate(existing.endsOn)}). Close it first, or edit its dates.`,
    };
  }

  const cycleId = cycleIdFor(dates.startsOn);
  const cycle: CycleRecord = {
    cycleId,
    name: cycleName(dates.startsOn),
    startsOn: dates.startsOn,
    endsOn: dates.endsOn,
    status: "active",
    datesDeclared: true,
    ...(input.focus ? { focus: input.focus } : {}),
    ...(input.coachDiscordId ? { coachDiscordId: input.coachDiscordId } : {}),
    ...(input.choreo?.trim() ? { choreo: input.choreo.trim() } : {}),
    createdBy: userId,
    createdAt: new Date().toISOString(),
  };

  await putCycle(env, cycle);
  await setCurrentCycle(env, cycleId);
  return { ok: true, cycle };
}

// ------------------------------------------------------------- the T-21 prompt

export interface CyclePromptResult {
  skipped?: "flag_off" | "no_cycle";
  prompted: boolean;
  cycle?: string;
}

/**
 * Daily: offers to start the next cycle once the current one is close to
 * ending.
 *
 * Posts rather than acts. Everything downstream — the poll, the dates, the
 * schedule — hangs off a coach clicking, which is what keeps a cycle from
 * being created by a cron on a week when nobody wanted one.
 */
export async function runCyclePrompt(env: Env): Promise<CyclePromptResult> {
  if (!(await isEnabled(env, "trainee_program"))) {
    return { skipped: "flag_off", prompted: false };
  }

  const cycle = await currentCycle(env);
  if (!cycle) return { skipped: "no_cycle", prompted: false };

  const promptDays = await getNumber(env, "cycle_prompt_days");
  if (!needsNextCyclePrompt(cycle, promptDays, new Date())) {
    return { prompted: false, cycle: cycle.cycleId };
  }

  const next = nextBlockAfter(cycle.startsOn);
  if (!next) return { prompted: false, cycle: cycle.cycleId };

  await postToChannelByName(
    env,
    env.GUILD_DANCE_ID,
    env.CH_COACHES_CONFIRMATION,
    nextCyclePrompt(cycle, next),
  );

  await putCycle(env, { ...cycle, nextPromptedAt: new Date().toISOString() });
  return { prompted: true, cycle: cycle.cycleId };
}

/**
 * The prompt, showing what the poll would ask before anyone commits to it.
 *
 * The dates are the block's Saturdays, which is the starting point rather than
 * the answer — the next step lets the coach add and remove before it goes up.
 */
export function nextCyclePrompt(
  current: CycleRecord,
  next: { startsOn: string; endsOn: string },
): MessagePayload {
  const saturdays = saturdaysBetween(next.startsOn, next.endsOn);
  const lines = [
    `📅 **${current.name} ends ${formatCycleDate(current.endsOn)}.** Time to line up the next one.`,
    "",
    `**${cycleName(next.startsOn)}** would run ${formatCycleDate(next.startsOn)} – ${formatCycleDate(next.endsOn)}.`,
    "",
    `Starting the next cycle asks the trainees which of these ${saturdays.length} Saturdays they can make.`,
    "You get to add and remove dates before the poll goes up, and the cycle's own",
    "dates are set afterwards from what they answer.",
    "",
    saturdays.map(formatCycleDate).join(" · "),
  ];

  return {
    content: lines.join("\n"),
    allowed_mentions: { parse: [] },
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SUCCESS,
            label: "Start the next cycle",
            custom_id: `cyc|begin|${cycleIdFor(next.startsOn)}`,
          },
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SECONDARY,
            label: "Not yet",
            custom_id: `cyc|defer|${cycleIdFor(next.startsOn)}`,
          },
        ],
      },
    ],
  };
}

// ------------------------------------------------------- the poll, in draft

export const CYCLE_PREFIX = "cyc";

export type CycleAction =
  | "begin"
  | "defer"
  | "dates"
  | "dates-save"
  | "post"
  | "manual-save"
  | "focus"
  | "close-poll"
  | "confirm"
  | "start-from-poll"
  | "book"
  | "book-save";

const CYCLE_ACTIONS: CycleAction[] = [
  "begin",
  "defer",
  "dates",
  "dates-save",
  "post",
  "manual-save",
  "focus",
  "close-poll",
  "confirm",
  "start-from-poll",
  "book",
  "book-save",
];

export function cycleCustomId(action: CycleAction, cycleId: string): string {
  return `${CYCLE_PREFIX}|${action}|${cycleId}`;
}

/**
 * `cyc|<action>|<cycleId>` plus an optional fourth field.
 *
 * The fourth carries whatever the action needs to remember — a session date,
 * for the booking modal — because a modal submit arrives with no memory of the
 * component that opened it.
 */
export function parseCycleCustomId(
  value: string,
): { action: CycleAction; cycleId: string; extra?: string } | null {
  const [prefix, action, cycleId, extra] = value.split("|");
  if (prefix !== CYCLE_PREFIX || !action || !cycleId) return null;
  if (!CYCLE_ACTIONS.includes(action as CycleAction)) return null;
  if (!/^[0-9a-z-]{4,}$/.test(cycleId)) return null;
  return { action: action as CycleAction, cycleId, ...(extra ? { extra } : {}) };
}

/**
 * A native poll caps at 10 answers, and "none of these" takes one of them.
 * Checked rather than trusted, because a coach adding dates by hand is exactly
 * how you get eleven.
 */
export const MAX_POLL_DATES = 9;

/** The doc's "none of these" — an answer, so abstaining is visible. */
export const NONE_OF_THESE = "None of these";

/**
 * [Start the next cycle] — drafts the poll without posting it.
 *
 * Nothing reaches the trainees here. The dates are a starting point, and the
 * coach gets to add and remove before anyone is asked, because a poll can't be
 * edited once it's up.
 */
export async function beginNextCycle(
  env: Env,
  cycleId: string,
  userId: string,
  declared?: DeclaredDates,
): Promise<CycleResult> {
  const existing = await getCycle(env, cycleId);

  // A closed cycle that never ran was a setup somebody abandoned, and starting
  // it again is the obvious next thing to want. One that has sessions did run,
  // and re-drafting over it would overwrite what happened.
  const abandoned =
    existing?.status === "closed" && (existing.sessions ?? []).length === 0;

  if (existing && existing.status !== "draft" && !abandoned) {
    return {
      ok: false,
      reason:
        `**${existing.name}** is \`${existing.status}\`, not a draft.` +
        (existing.status === "polling"
          ? " Its poll is still open — close it from the card, or `/cycle close` to cancel it."
          : " `/cycle schedule` edits it; `/cycle close` finishes it."),
    };
  }

  // Started over, not resumed: the old poll and its answers belong to the
  // attempt that was abandoned.
  const reuse = abandoned ? undefined : existing;

  const current = await currentCycle(env);
  const block = current ? nextBlockAfter(current.startsOn) : null;
  if (!block) return { ok: false, reason: "No current cycle to follow — run `/cycle start`." };

  const draft: CycleRecord = reuse ?? {
    cycleId,
    name: cycleName(block.startsOn),
    // The block is a proposal until the schedule narrows it; the real dates are
    // written once the coach has picked sessions.
    startsOn: block.startsOn,
    endsOn: block.endsOn,
    proposedStartsOn: block.startsOn,
    proposedEndsOn: block.endsOn,
    ...(declared ? { startsOn: declared.startsOn, endsOn: declared.endsOn, datesDeclared: true } : {}),
    status: "draft",
    pollDates: saturdaysBetween(block.startsOn, block.endsOn).slice(0, MAX_POLL_DATES),
    createdBy: userId,
    createdAt: new Date().toISOString(),
  };

  await putCycle(env, draft);
  return { ok: true, cycle: draft };
}

export function pollDraftCard(cycle: CycleRecord): MessagePayload {
  const dates = cycle.pollDates ?? [];

  // Once the poll is up the dates are fixed — Discord won't edit a poll — so
  // the only thing left to offer is ending it early.
  if (cycle.status === "polling") {
    const closes = cycle.pollClosesAt
      ? `<t:${Math.floor(new Date(cycle.pollClosesAt).getTime() / 1000)}:R>`
      : "soon";
    return {
      content: [
        `🗳️ **${cycle.name} — poll is open**, closing ${closes}.`,
        cycle.focus ? `Focus: **${cycle.focus}**` : "⚠️ No focus picked yet.",
        "",
        "I'll bring the answers back here when it closes.",
      ].join("\n"),
      allowed_mentions: { parse: [] },
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.BUTTON,
              style: ButtonStyle.SECONDARY,
              label: "Close the poll now",
              custom_id: cycleCustomId("close-poll", cycle.cycleId),
            },
          ],
        },
      ],
    };
  }
  return {
    content: [
      `🗳️ **${cycle.name} — availability poll, not posted yet**`,
      cycle.focus ? `Focus: **${cycle.focus}**` : "⚠️ No focus picked yet.",
      "",
      `Asking about ${dates.length} date${dates.length === 1 ? "" : "s"}:`,
      ...dates.map((d) => `• ${formatCycleDate(d)}`),
      "",
      "_A poll can't be edited once it's up, so change the dates now if you need to._",
    ].join("\n"),
    allowed_mentions: { parse: [] },
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.STRING_SELECT,
            custom_id: cycleCustomId("focus", cycle.cycleId),
            placeholder: cycle.focus ? `Focus: ${cycle.focus}` : "What does this cycle train?",
            min_values: 1,
            max_values: 1,
            options: CYCLE_FOCUSES.map((name) => ({
              label: name,
              value: name,
              ...(cycle.focus === name ? { default: true } : {}),
            })),
          },
        ],
      },
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SUCCESS,
            label: "Post the poll",
            custom_id: cycleCustomId("post", cycle.cycleId),
          },
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SECONDARY,
            label: "Edit dates",
            custom_id: cycleCustomId("dates", cycle.cycleId),
          },
        ],
      },
    ],
  };
}

export async function setCycleFocus(
  env: Env,
  cycleId: string,
  focus: string,
): Promise<CycleResult> {
  const cycle = await getCycle(env, cycleId);
  if (!cycle) return { ok: false, reason: "That cycle is no longer on file." };
  if (!isCycleFocus(focus)) return { ok: false, reason: `"${focus}" isn't one of the five.` };

  const updated: CycleRecord = { ...cycle, focus };
  await putCycle(env, updated);
  return { ok: true, cycle: updated };
}

/** Replaces the poll's dates with whatever the coach typed, one per line. */
export async function setPollDates(
  env: Env,
  cycleId: string,
  text: string,
): Promise<CycleResult> {
  const cycle = await getCycle(env, cycleId);
  if (!cycle) return { ok: false, reason: "That cycle is no longer on file." };
  if (cycle.status !== "draft") {
    return { ok: false, reason: "The poll is already up — dates can't change now." };
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const dates: string[] = [];
  for (const line of lines) {
    if (!parseIsoDate(line)) {
      return { ok: false, reason: `\`${line}\` isn't a date. One per line, YYYY-MM-DD.` };
    }
    if (!dates.includes(line)) dates.push(line);
  }

  if (dates.length === 0) return { ok: false, reason: "A poll needs at least one date." };
  if (dates.length > MAX_POLL_DATES) {
    return {
      ok: false,
      reason: `Discord allows ${MAX_POLL_DATES + 1} answers and one is "${NONE_OF_THESE}", so ${MAX_POLL_DATES} dates is the limit. You gave ${dates.length}.`,
    };
  }

  dates.sort();
  const updated: CycleRecord = { ...cycle, pollDates: dates };
  await putCycle(env, updated);
  return { ok: true, cycle: updated };
}

/** [Post the poll] — the first thing trainees see. */
export async function postAvailabilityPoll(
  env: Env,
  cycleId: string,
): Promise<CycleResult> {
  const cycle = await getCycle(env, cycleId);
  if (!cycle) return { ok: false, reason: "That cycle is no longer on file." };
  if (cycle.status !== "draft") {
    return { ok: false, reason: `The poll for **${cycle.name}** is already up.` };
  }

  const dates = cycle.pollDates ?? [];
  if (dates.length === 0) return { ok: false, reason: "There are no dates to ask about." };

  const days = await getNumber(env, "poll_days");
  const posted = await postToChannelByName(env, env.GUILD_DANCE_ID, env.CH_ANNOUNCEMENTS, {
    poll: {
      question: { text: `${cycle.name} — which Saturdays can you make?` },
      answers: [
        ...dates.map((d) => ({ poll_media: { text: formatCycleDate(d) } })),
        { poll_media: { text: NONE_OF_THESE } },
      ],
      duration: Math.max(1, Math.round(days * 24)),
      allow_multiselect: true,
    },
  });

  const updated: CycleRecord = {
    ...cycle,
    status: "polling",
    pollMessageId: posted.id,
    pollChannelId: posted.channelId,
    pollClosesAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  };
  await putCycle(env, updated);
  return { ok: true, cycle: updated };
}

// ------------------------------------------------------- scheduling by hand

/**
 * Writes the sessions, skipping the poll entirely.
 *
 * The doc's flow discovers dates by asking; this one records dates somebody
 * already settled. Both end in the same place — a cycle with a schedule — and
 * the manual path is the one that works when the asking happened in a channel
 * three weeks before any of this existed.
 */
export interface DeclaredDates {
  startsOn: string;
  endsOn: string;
}

export async function setSchedule(
  env: Env,
  cycleId: string | null,
  text: string,
  focus?: string,
  declared?: DeclaredDates,
): Promise<CycleResult> {
  const parsed = parseSessionLines(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const span = sessionSpan(parsed.sessions);
  if (!span) return { ok: false, reason: "A schedule needs at least one session." };

  // A stated range that leaves practices outside it is almost always a typo,
  // and the alternative is a cycle whose own dates disown its sessions.
  let stated: DeclaredDates | undefined;
  if (declared) {
    const valid = validateCycleDates(declared.startsOn, declared.endsOn);
    if (!valid.ok) return { ok: false, reason: valid.reason };

    const outside = parsed.sessions.filter(
      (session) => session.date < valid.startsOn || session.date > valid.endsOn,
    );
    if (outside.length > 0) {
      return {
        ok: false,
        reason:
          `That range leaves ${outside.length} session(s) outside it — ` +
          `${outside.map((session) => formatCycleDate(session.date)).join(", ")}.`,
      };
    }
    stated = { startsOn: valid.startsOn, endsOn: valid.endsOn };
  }

  const existing = cycleId ? await getCycle(env, cycleId) : await currentCycle(env);

  // Nothing to attach to: the schedule *is* the cycle. Its name and dates come
  // from the sessions, which is the only honest source when nobody declared
  // them separately.
  if (!existing) {
    const created: CycleRecord = {
      cycleId: cycleIdFor(stated?.startsOn ?? span.startsOn),
      name: cycleName(stated?.startsOn ?? span.startsOn),
      startsOn: stated?.startsOn ?? span.startsOn,
      endsOn: stated?.endsOn ?? span.endsOn,
      ...(stated ? { datesDeclared: true } : {}),
      status: "active",
      sessions: parsed.sessions,
      ...(focus && isCycleFocus(focus) ? { focus } : {}),
      createdAt: new Date().toISOString(),
    };
    await putCycle(env, created);
    await setCurrentCycle(env, created.cycleId);
    return { ok: true, cycle: created };
  }

  // A cycle that hasn't started takes its dates from the schedule. One already
  // running keeps what was declared where that still describes the sessions,
  // and follows them where it doesn't — see cycleRangeFor.
  const starting = existing.status !== "active" && existing.status !== "closed";
  // A range stated now wins outright; otherwise the existing one is kept or
  // followed depending on whether anybody ever stated it.
  const range =
    stated ??
    (starting && !existing.datesDeclared
      ? span
      : cycleRangeFor(
          { startsOn: existing.startsOn, endsOn: existing.endsOn },
          span,
          existing.datesDeclared,
        ));

  const updated: CycleRecord = {
    ...existing,
    sessions: parsed.sessions,
    status: "active",
    ...(focus && isCycleFocus(focus) ? { focus } : {}),
    ...(stated || existing.datesDeclared ? { datesDeclared: true } : {}),
    startsOn: range.startsOn,
    endsOn: range.endsOn,
  };

  await putCycle(env, updated);
  await setCurrentCycle(env, updated.cycleId);
  return { ok: true, cycle: updated };
}

/** The schedule as a coach reads it back. */
export function scheduleSummary(cycle: CycleRecord): string {
  const sessions = cycle.sessions ?? [];
  if (sessions.length === 0) return "_No sessions yet._";

  // Falls back to the cycle's coach rather than showing nothing: an unmarked
  // session is led by whoever normally leads, and saying so is the point.
  const fallback = cycle.coachDiscordId ? `<@${cycle.coachDiscordId}>` : "";

  return sessions
    .map((s) => {
      const lead = s.lead || fallback;
      const who =
        s.attendees?.length
          ? ` · ${s.attendees.join(", ")}`
          : s.votes !== undefined
            ? ` · ${s.votes} expected`
            : "";
      return `• ${formatCycleDate(s.date)} · ${s.start}–${s.end}${lead ? ` · led by ${lead}` : ""}${who}`;
    })
    .join("\n");
}

/**
 * Drafts the next cycle's poll and returns the card to post.
 *
 * Shared by the T-21 prompt's button and `/cycle poll`, so the two can't drift
 * — the difference between them is only what made the coach reach for it, not
 * what happens next.
 */
export async function draftNextCyclePoll(
  env: Env,
  userId: string,
  cycleId?: string,
  declared?: DeclaredDates,
): Promise<{ ok: true; cycle: CycleRecord; card: MessagePayload } | { ok: false; reason: string }> {
  let id = cycleId;

  if (!id) {
    const current = await currentCycle(env);
    if (!current) {
      return { ok: false, reason: "No cycle on record — run `/cycle start` first." };
    }
    const block = nextBlockAfter(current.startsOn);
    if (!block) return { ok: false, reason: "Couldn't work out which block comes next." };
    id = cycleIdFor(block.startsOn);
  }

  const begun = await beginNextCycle(env, id, userId, declared);
  if (!begun.ok) return begun;
  return { ok: true, cycle: begun.cycle, card: pollDraftCard(begun.cycle) };
}

// ------------------------------------------------------------------ closing

/**
 * `/cycle close` — marks a cycle finished so the next one can start.
 *
 * Deliberately just the state change. The doc's rank 11 close does considerably
 * more — works out who was enrolled from attendance, writes cycles_completed,
 * counts skips, and lists unresolved auditions — and every one of those needs
 * the Trainees table, which doesn't exist. Doing the bookkeeping half badly
 * would be worse than not doing it, so this closes the cycle and says what
 * rank 11 would have added.
 */
/**
 * Finds the cycle a bare `/cycle close` means.
 *
 * The current one if it's still going, otherwise any record that isn't closed —
 * which is how a cycle still being set up gets cancelled. Only `start` and
 * `schedule` set `cycle:current`, so a drafted or polling cycle is never it,
 * and looking only there left those with no way out.
 */
async function openCycle(env: Env): Promise<CycleRecord | null> {
  const current = await currentCycle(env);
  if (current && current.status !== "closed") return current;

  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: RECORD_PREFIX, cursor });
    for (const key of page.keys) {
      const cycle = await env.KV.get<CycleRecord>(key.name, "json");
      if (cycle && cycle.status !== "closed") return cycle;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return current;
}

/**
 * `/cycle close` — marks a cycle finished so the next one can start.
 *
 * Deliberately just the state change. The doc's rank 11 close does considerably
 * more — works out who was enrolled from attendance, writes cycles_completed,
 * counts skips, and lists unresolved auditions — and every one of those needs
 * the Trainees table, which doesn't exist. Doing the bookkeeping half badly
 * would be worse than not doing it, so this closes the cycle and says what
 * rank 11 would have added.
 */
export async function closeCycle(env: Env, cycleId?: string): Promise<CycleResult> {
  const cycle = cycleId ? await getCycle(env, cycleId) : await openCycle(env);
  if (!cycle) return { ok: false, reason: "No cycle on record to close." };
  if (cycle.status === "closed") {
    return { ok: false, reason: `**${cycle.name}** is already closed, and nothing else is open.` };
  }

  // A cycle cancelled mid-setup leaves a live poll behind otherwise.
  if (cycle.status === "polling" && cycle.pollMessageId && cycle.pollChannelId) {
    try {
      await expirePoll(env, cycle.pollChannelId, cycle.pollMessageId);
    } catch (err) {
      console.error("couldn't expire the poll while closing", cycle.cycleId, err);
    }
  }

  const updated: CycleRecord = { ...cycle, status: "closed", closedAt: new Date().toISOString() };
  await putCycle(env, updated);
  // cycle:current keeps pointing where it did on purpose: the last cycle that
  // actually ran is still the one everything is relative to until a new one
  // replaces it, and startCycle allows a new one once this is closed.
  return { ok: true, cycle: updated };
}

// ------------------------------------------------------- the poll, closing

/**
 * Reads a finished poll and lays the answers out for the coach.
 *
 * The voters are fetched per answer, not just the counts — a session needs the
 * list of people, and pre-filling attendance from it is the difference between
 * this saving work and merely reporting.
 */
export async function readPollResults(
  env: Env,
  cycle: CycleRecord,
): Promise<{ date: string; names: string[] }[] | null> {
  if (!cycle.pollMessageId || !cycle.pollChannelId) return null;

  const message = await getMessage(env, cycle.pollChannelId, cycle.pollMessageId);
  const answers = message.poll?.answers ?? [];
  const dates = cycle.pollDates ?? [];
  const out: { date: string; names: string[] }[] = [];

  // Answers were created in the order of pollDates, with "None of these" last,
  // so position maps them back. Anything past the dates is that last answer.
  for (const [i, answer] of answers.entries()) {
    const date = dates[i];
    if (!date) continue;

    let names: string[] = [];
    try {
      const users = await pollAnswerVoters(
        env,
        cycle.pollChannelId,
        cycle.pollMessageId,
        answer.answer_id,
      );
      names = users.map((u) => u.global_name ?? u.username ?? u.id);
    } catch (err) {
      console.error("couldn't read poll voters", answer.answer_id, err);
    }
    out.push({ date, names });
  }
  return out;
}

/** The schedule lines a poll's answers imply, ready for the coach to edit. */
export function pollResultLines(
  results: readonly { date: string; names: string[] }[],
  times: string,
): string {
  return results
    .filter((r) => r.names.length > 0)
    .map((r) => `${r.date} ${times}${r.names.length ? ` | ${r.names.join(", ")}` : ""}`)
    .join("\n");
}

export function pollResultsCard(
  cycle: CycleRecord,
  results: readonly { date: string; names: string[] }[],
): MessagePayload {
  const answered = results.filter((r) => r.names.length > 0);
  return {
    content: [
      `🗳️ **${cycle.name} — the poll is closed.**`,
      cycle.focus ? `Focus: **${cycle.focus}**` : "⚠️ No focus picked yet.",
      "",
      ...results.map(
        (r) =>
          `• ${formatCycleDate(r.date)} — **${r.names.length}**${r.names.length ? ` · ${r.names.join(", ")}` : ""}`,
      ),
      "",
      answered.length > 0
        ? `**Start the cycle** takes these ${answered.length} date(s) at ${DEFAULT_SESSION_START}–${DEFAULT_SESSION_END} with those people. **Edit first** opens them so you can change times, drop dates or set who's leading.`
        : "⚠️ Nobody picked a date, so there's nothing to start from.",
    ].join("\n"),
    allowed_mentions: { parse: [] },
    components:
      answered.length === 0
        ? []
        : [
            {
              type: ComponentType.ACTION_ROW,
              components: [
                {
                  type: ComponentType.BUTTON,
                  style: ButtonStyle.SUCCESS,
                  label: "Start the cycle",
                  custom_id: cycleCustomId("start-from-poll", cycle.cycleId),
                },
                {
                  type: ComponentType.BUTTON,
                  style: ButtonStyle.SECONDARY,
                  label: "Edit first",
                  custom_id: cycleCustomId("confirm", cycle.cycleId),
                },
              ],
            },
          ],
  };
}

export interface PollCloseResult {
  skipped?: "flag_off";
  checked: number;
  reported: number;
}

/**
 * Daily: brings a finished poll's answers back to the coaches.
 *
 * Reports rather than acts — the dates it suggests are what people said they
 * could make, which is an input to the coach's decision and not the decision.
 */
export async function runPollClose(env: Env): Promise<PollCloseResult> {
  if (!(await isEnabled(env, "trainee_program"))) {
    return { skipped: "flag_off", checked: 0, reported: 0 };
  }

  const now = Date.now();
  let cursor: string | undefined;
  let checked = 0;
  let reported = 0;

  do {
    const page = await env.KV.list({ prefix: RECORD_PREFIX, cursor });
    for (const key of page.keys) {
      const cycle = await env.KV.get<CycleRecord>(key.name, "json");
      if (!cycle || cycle.status !== "polling" || !cycle.pollClosesAt) continue;
      checked++;
      if (new Date(cycle.pollClosesAt).getTime() > now) continue;

      const results = await readPollResults(env, cycle);
      if (!results) continue;

      await postToChannelByName(
        env,
        env.GUILD_DANCE_ID,
        env.CH_COACHES_CONFIRMATION,
        pollResultsCard(cycle, results),
      );
      // Moved on before the card is answered, so a second day doesn't repost.
      await putCycle(env, { ...cycle, status: "scheduling", pollResults: results });
      reported++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { checked, reported };
}

/** [Close the poll now] — the "I've seen enough" path. */
export async function closePollEarly(env: Env, cycleId: string): Promise<CycleResult> {
  const cycle = await getCycle(env, cycleId);
  if (!cycle) return { ok: false, reason: "That cycle is no longer on file." };
  if (cycle.status !== "polling" || !cycle.pollMessageId || !cycle.pollChannelId) {
    return { ok: false, reason: "There's no open poll on that cycle." };
  }

  try {
    await expirePoll(env, cycle.pollChannelId, cycle.pollMessageId);
  } catch (err) {
    return {
      ok: false,
      reason: `Couldn't close the poll: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Backdated so the next sweep picks it up, rather than duplicating the
  // read-and-report logic here.
  const updated: CycleRecord = { ...cycle, pollClosesAt: new Date().toISOString() };
  await putCycle(env, updated);
  return { ok: true, cycle: updated };
}

/** The cycle with a poll up, whether or not it's the current one. */
async function pollingCycle(env: Env): Promise<CycleRecord | null> {
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: RECORD_PREFIX, cursor });
    for (const key of page.keys) {
      const cycle = await env.KV.get<CycleRecord>(key.name, "json");
      if (cycle?.status === "polling") return cycle;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return null;
}

/**
 * Ends a poll and brings its answers back, in one step.
 *
 * Shared by the card's button and `/cycle poll-close`, so the two can't drift.
 * The command exists because the button is only reachable if you can still find
 * the card, and a week of channel traffic makes that a real if.
 */
export async function closePollAndReport(
  env: Env,
  cycleId?: string,
): Promise<{ ok: true; cycle: CycleRecord; card: MessagePayload } | { ok: false; reason: string }> {
  const target = cycleId ? await getCycle(env, cycleId) : await pollingCycle(env);
  if (!target) return { ok: false, reason: "No cycle has a poll open." };

  const closed = await closePollEarly(env, target.cycleId);
  if (!closed.ok) return closed;

  const results = (await readPollResults(env, closed.cycle)) ?? [];
  const updated: CycleRecord = { ...closed.cycle, status: "scheduling", pollResults: results };
  await putCycle(env, updated);

  return { ok: true, cycle: updated, card: pollResultsCard(updated, results) };
}

/**
 * [Start the cycle] — straight from the poll, no editing step.
 *
 * The card above it already showed every date and every name, so this is the
 * confirmation rather than a shortcut past one. Times fall back to the
 * standard slot; /cycle schedule changes them afterwards.
 */
export async function startFromPoll(env: Env, cycleId: string): Promise<CycleResult> {
  const cycle = await getCycle(env, cycleId);
  if (!cycle) return { ok: false, reason: "That cycle is no longer on file." };

  const results = cycle.pollResults ?? [];
  const lines = pollResultLines(
    results,
    `${DEFAULT_SESSION_START}-${DEFAULT_SESSION_END}`,
  );
  if (!lines) {
    return { ok: false, reason: "Nobody picked a date, so there is nothing to start from." };
  }

  return setSchedule(env, cycleId, lines);
}
// ------------------------------------------------------- rank 9: the window

/**
 * The Thursday list, as a card.
 *
 * Shows the vote count and what each attendee would pay, because the cost is
 * the thing a coach weighs when choosing between a library room and a studio —
 * and "—" where nobody is expected, rather than a number derived from nothing.
 */
export function bookingWindowCard(
  cycle: CycleRecord,
  open: readonly CycleSession[],
  leadDays: number,
  now: Date,
): MessagePayload {
  const lines = open.map((s) => {
    const waited = daysWaiting(s, leadDays, now);
    const age = waited >= 1 ? ` · open ${waited}d` : "";
    const lead = s.lead ? ` · ${s.lead}` : "";
    return `• **${formatCycleDate(s.date)}** ${s.start}–${s.end}${lead} · ${s.votes ?? "—"} expected${age}`;
  });

  return {
    content: [
      `🏫 **${cycle.name} — ${open.length} session(s) can be booked now.**`,
      "",
      ...lines,
      "",
      "The library opens 30 days out, so these are live today. A session that",
      "passes its date unbooked is simply lost.",
    ].join("\n"),
    allowed_mentions: { parse: [] },
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.STRING_SELECT,
            custom_id: cycleCustomId("book", cycle.cycleId),
            placeholder: "Mark one booked…",
            min_values: 1,
            max_values: 1,
            options: open.slice(0, 25).map((s) => ({
              label: `${formatCycleDate(s.date)} · ${s.start}–${s.end}`,
              value: s.date,
            })),
          },
        ],
      },
    ],
  };
}

/** Records the room, on the session itself. */
export async function markBooked(
  env: Env,
  cycleId: string,
  date: string,
  userId: string,
  input: BookingInput,
): Promise<CycleResult> {
  const cycle = await getCycle(env, cycleId);
  if (!cycle) return { ok: false, reason: "That cycle is no longer on file." };

  const sessions = cycle.sessions ?? [];
  const target = sessions.find((s) => s.date === date);
  if (!target) return { ok: false, reason: `No session on ${formatCycleDate(date)}.` };

  const validated = validateBooking(input);
  if (!validated.ok) return { ok: false, reason: validated.reason };

  const booking: SessionBooking = {
    ...validated.booking,
    bookedBy: userId,
    bookedAt: new Date().toISOString(),
  };

  const updated: CycleRecord = {
    ...cycle,
    sessions: sessions.map((s) => (s.date === date ? { ...s, booking } : s)),
  };
  await putCycle(env, updated);
  return { ok: true, cycle: updated };
}

/** The last room booked, to prefill the next one. Venues repeat. */
export function lastBooking(cycle: CycleRecord): SessionBooking | null {
  const booked = (cycle.sessions ?? [])
    .filter((s) => s.booking)
    .sort((a, b) => (a.booking?.bookedAt ?? "").localeCompare(b.booking?.bookedAt ?? ""));
  return booked.at(-1)?.booking ?? null;
}

export interface BookingWindowResult {
  skipped?: "flag_off" | "no_cycle";
  open: number;
  posted: boolean;
}

/**
 * Posts the list of sessions whose window is open and which have no room yet.
 *
 * Quiet when there's nothing to say, and quiet again for booking_repost_days
 * after it has said it — the doc's "still unbooked after 3 days → repost",
 * expressed as a cooldown so a daily run doesn't nag daily.
 */
export async function runBookingWindow(env: Env): Promise<BookingWindowResult> {
  if (!(await isEnabled(env, "bookings"))) {
    return { skipped: "flag_off", open: 0, posted: false };
  }

  const cycle = await currentCycle(env);
  if (!cycle || cycle.status !== "active") {
    return { skipped: "no_cycle", open: 0, posted: false };
  }

  const [leadDays, repostDays] = await Promise.all([
    getNumber(env, "booking_lead_days"),
    getNumber(env, "booking_repost_days"),
  ]);
  const now = new Date();
  const open = bookableSessions(cycle.sessions ?? [], leadDays, now);
  if (open.length === 0) return { open: 0, posted: false };

  const since = cycle.bookingPostedAt
    ? (now.getTime() - new Date(cycle.bookingPostedAt).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;
  if (since < repostDays) return { open: open.length, posted: false };

  await postToChannelByName(
    env,
    env.GUILD_DANCE_ID,
    env.CH_COACHES_CONFIRMATION,
    bookingWindowCard(cycle, open, leadDays, now),
  );
  await putCycle(env, { ...cycle, bookingPostedAt: now.toISOString() });
  return { open: open.length, posted: true };
}

// ---------------------------------------------------- session reminders

export function sessionReminderCard(
  cycle: CycleRecord,
  session: CycleSession,
): MessagePayload {
  const where = session.booking
    ? `${session.booking.venue}${session.booking.room ? ` ${session.booking.room}` : ""}`
    : "⚠️ no room booked yet";
  const who = session.attendees?.length
    ? `\n**Expected:** ${session.attendees.join(", ")}`
    : "";

  return {
    content: [
      `📣 **Training in 2 days — ${formatCycleDate(session.date)}**`,
      `${session.start}–${session.end} · ${where}`,
      session.lead ? `Led by ${session.lead}` : "",
      cycle.focus ? `Focus: **${cycle.focus}**` : "",
      who,
    ]
      .filter(Boolean)
      .join("\n"),
    allowed_mentions: { parse: [] },
  };
}

export function videoReminderCard(session: CycleSession): MessagePayload {
  return {
    content: [
      `🎥 **Training is tomorrow — ${formatCycleDate(session.date)}.**`,
      "",
      "Anything you want eyes on, post it today. A video put up tomorrow gets",
      "watched after the session, which is the wrong way round.",
      "",
      "Auditioning this cycle? `/audition submit` if yours is ready.",
    ].join("\n"),
    allowed_mentions: { parse: [] },
  };
}

export interface ReminderResult {
  skipped?: "flag_off" | "no_cycle";
  sessionReminders: number;
  videoReminders: number;
}

/**
 * Daily: the two nudges before a session.
 *
 * Into #announcements, where the rest of the cycle's news goes — a reminder
 * nobody sees is the same as no reminder, and #trainee-bot is where trainees
 * run commands rather than where they read.
 */
export async function runSessionReminders(env: Env): Promise<ReminderResult> {
  if (!(await isEnabled(env, "trainee_program"))) {
    return { skipped: "flag_off", sessionReminders: 0, videoReminders: 0 };
  }

  const cycle = await currentCycle(env);
  if (!cycle || cycle.status !== "active") {
    return { skipped: "no_cycle", sessionReminders: 0, videoReminders: 0 };
  }

  const [sessionDays, videoDays] = await Promise.all([
    getNumber(env, "session_reminder_days"),
    getNumber(env, "video_reminder_days"),
  ]);
  const now = new Date();
  const stamp = now.toISOString();

  let sessions = cycle.sessions ?? [];
  let sessionReminders = 0;
  let videoReminders = 0;

  for (const session of dueReminders(sessions, "session", sessionDays, now)) {
    await postToChannelByName(
      env,
      env.GUILD_DANCE_ID,
      env.CH_ANNOUNCEMENTS,
      sessionReminderCard(cycle, session),
    );
    sessions = sessions.map((s) =>
      s.date === session.date ? { ...s, remindedSessionAt: stamp } : s,
    );
    sessionReminders++;
  }

  for (const session of dueReminders(sessions, "video", videoDays, now)) {
    await postToChannelByName(
      env,
      env.GUILD_DANCE_ID,
      env.CH_ANNOUNCEMENTS,
      videoReminderCard(session),
    );
    sessions = sessions.map((s) =>
      s.date === session.date ? { ...s, remindedVideoAt: stamp } : s,
    );
    videoReminders++;
  }

  if (sessionReminders + videoReminders > 0) {
    await putCycle(env, { ...cycle, sessions });
  }
  return { sessionReminders, videoReminders };
}

// ------------------------------------------------- rank 12: auditions open

export function auditionsOpenCard(
  cycle: CycleRecord,
  window: { opensOn: string; closesOn: string },
  traineeChannel: string,
): MessagePayload {
  const closes = Math.floor(new Date(`${window.closesOn}T23:59:00Z`).getTime() / 1000);
  return {
    content: [
      `🎤 **Auditions are open for ${cycle.name}.**`,
      "",
      "Auditioning for Hearts or Spades? Put a song forward and a coach will",
      `approve it or suggest another. Proposals close <t:${closes}:D> (<t:${closes}:R>).`,
      "",
      `\`/audition propose\` in #${traineeChannel}`,
    ].join("\n"),
    allowed_mentions: { parse: [] },
  };
}

export interface AuditionsOpenResult {
  skipped?: "flag_off" | "no_cycle";
  announced: boolean;
}

/**
 * Daily: announces the audition window the day it opens.
 *
 * Announces only. Nothing here stops a proposal outside the window — that's a
 * separate decision about whether the window is a rule or a guide, and saying
 * it's open is useful either way.
 */
export async function runAuditionsOpen(env: Env): Promise<AuditionsOpenResult> {
  if (!(await isEnabled(env, "auditions"))) {
    return { skipped: "flag_off", announced: false };
  }

  const cycle = await currentCycle(env);
  if (!cycle || cycle.status !== "active" || cycle.auditionsAnnouncedAt) {
    return { skipped: cycle ? undefined : "no_cycle", announced: false };
  }

  const [openDays, closeDays] = await Promise.all([
    getNumber(env, "audition_open_days"),
    getNumber(env, "audition_close_days"),
  ]);
  const window = auditionWindow(cycle, openDays, closeDays);
  if (!window) return { announced: false };

  const today = new Date().toISOString().slice(0, 10);
  // On or after the open date, so a cycle created inside its own window still
  // gets announced rather than missing it by having been set up late.
  if (today < window.opensOn || today > window.closesOn) return { announced: false };

  await postToChannelByName(
    env,
    env.GUILD_DANCE_ID,
    env.CH_ANNOUNCEMENTS,
    auditionsOpenCard(cycle, window, env.CH_TRAINEE_BOT),
  );
  await putCycle(env, { ...cycle, auditionsAnnouncedAt: new Date().toISOString() });
  return { announced: true };
}
