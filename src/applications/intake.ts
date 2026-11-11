import { readApplications, type SheetPage } from "../appsScript";
import type { AuditionMethod } from "../config/columns";
import { getDirectorIds } from "../config/directors";
import { isEnabled } from "../config/flags";
import { getNumber } from "../config/settings";
import {
  alertDirectors,
  createThreadOnMessage,
  editMessage,
  postMessage,
  postToChannelByName,
} from "../discord/rest";
import type { MessagePayload } from "../discord/types";
import type { Env } from "../env";
import { buildIntakeMessage, type CardState } from "./card";
import {
  emptyDecision,
  type Decision,
  type OutcomeRecord,
  type PendingOutcome,
} from "./decision";
import { parseRow, verifyPinnedHeaders, type ApplicationRow } from "./fields";
import type { InterviewRecord } from "./interviewSlot";
import { buildSheetRowUrl } from "./sheetLink";
import { collectVideoGroups, type VideoGroup } from "./videos";

const CARDED_TTL = 400 * 24 * 60 * 60; // seconds; well past a season
const HEADER_ALERT_THROTTLE = 6 * 60 * 60;

/**
 * What we remember about a posted card, so it can be edited later.
 *
 * `values` and `videos` are caches of what the card was last rendered from. They
 * exist so a vote re-renders the card without an Apps Script round trip and
 * without re-fetching every video link on every click. [Open row] always reads
 * live, and the daily jobs refresh both.
 *
 * TODO: when the application sheet gains a status column, the decision belongs
 * there - KV is "idempotency + caches" (design doc s1), not a system of record.
 */
export interface CardRecord {
  row: number;
  messageId: string;
  channelId: string;
  method: AuditionMethod;
  state: CardState;
  /**
   * What the card was before it closed, so [Reopen] restores that rather than
   * assuming every closure was an audition-form timeout.
   */
  closedFrom?: CardState;
  /** ISO. Restarts on reopen - the clock measures the current wait, not the first. */
  waitingSince: string;
  /** Thread opened on the card, where everything about this applicant is said. */
  threadId?: string;
  /** Someone chose to skip the interview, so the outcome buttons are drawn. */
  outcomesRevealed?: boolean;
  values?: string[];
  videos?: VideoGroup[];
  /**
   * Videos from the separate audition form. Kept apart from `videos`, which is
   * recomputed from the application row every time the card is redrawn and
   * would otherwise wipe them.
   */
  auditionVideos?: VideoGroup[];
  decision?: Decision;
  interview?: InterviewRecord;
  outcome?: OutcomeRecord;
  pending?: PendingOutcome;
}

export const CARDED_PREFIX = "app:carded:";
const cardedKey = (row: number) => `${CARDED_PREFIX}${row}`;

/**
 * Records this isolate has written, so a click that follows a click reads its
 * own write back.
 *
 * KV is eventually consistent: a read within about a minute of a write can
 * still hand back the previous value. On a tally that's invisible — the next
 * redraw corrects it. On the applicant-facing feedback box it is not: the
 * prefill arrives holding the note you just replaced, which reads as the wrong
 * applicant's text.
 *
 * Bounded to roughly the window KV is stale for. Past that, KV is the better
 * answer anyway, because another isolate may have written since.
 */
const RECENT_WRITE_MS = 60_000;
const recentWrites = new Map<number, { record: CardRecord; at: number }>();

export async function getRecord(env: Env, row: number): Promise<CardRecord | null> {
  const recent = recentWrites.get(row);
  if (recent && Date.now() - recent.at < RECENT_WRITE_MS) return recent.record;
  if (recent) recentWrites.delete(row);
  return env.KV.get<CardRecord>(cardedKey(row), "json");
}

export async function putRecord(env: Env, record: CardRecord): Promise<void> {
  await env.KV.put(cardedKey(record.row), JSON.stringify(record), {
    expirationTtl: CARDED_TTL,
  });
  // Only after the write lands, so a failed put doesn't leave this isolate
  // believing something KV never accepted.
  const now = Date.now();
  for (const [row, entry] of recentWrites) {
    if (now - entry.at >= RECENT_WRITE_MS) recentWrites.delete(row);
  }
  recentWrites.set(record.row, { record, at: now });
}

export function sheetRowUrl(env: Env, row: number): string | undefined {
  return buildSheetRowUrl(env.APPLICATION_SHEET_URL ?? "", row);
}

/**
 * Posts a new message about a card, mentioning the directors.
 *
 * Always a new message, never an edit: Discord doesn't notify on edits, so a
 * card changing state on its own is invisible to anyone not already looking.
 */
export async function announceOnCard(
  env: Env,
  record: CardRecord,
  body: string,
): Promise<void> {
  const [directorIds, quiet] = await Promise.all([
    getDirectorIds(env),
    isEnabled(env, "quiet_pings"),
  ]);
  if (directorIds.length === 0) return;

  // Into the applicant's thread where there is one, so the channel stays a list
  // of cards rather than a running commentary. A mention still notifies, and
  // pulls the mentioned person into the thread.
  const target = record.threadId ?? record.channelId;
  const link = record.threadId
    ? ""
    : `\nhttps://discord.com/channels/${env.GUILD_COMMUNITY_ID}/${record.channelId}/${record.messageId}`;

  try {
    await postMessage(env, target, {
      content: quiet ? `${body}${link}` : `${directorIds.map((id) => `<@${id}>`).join(" ")} — ${body}${link}`,
      allowed_mentions: { parse: [], users: quiet ? [] : directorIds },
    });
  } catch (err) {
    console.error("announceOnCard failed", record.row, err);
  }
}

/** RISK-process applicants wait on a second form; everyone else is reviewable now. */
export function initialState(row: ApplicationRow): CardState {
  return row.auditionMethod === "risk_process" ? "awaiting" : "open";
}

export async function dueAt(env: Env, waitingSince: Date): Promise<Date> {
  const days = await getNumber(env, "application_audition_days");
  return new Date(waitingSince.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Header check gate. Returns false when the job must stop.
 *
 * Throttled: without this, a form with shifted columns alerts on every single
 * submission and every backstop run.
 */
export async function headersOk(env: Env, page: SheetPage): Promise<boolean> {
  const check = verifyPinnedHeaders(page.headers);
  if (check.ok) return true;

  const throttleKey = "alert:application-headers";
  if (!(await env.KV.get(throttleKey))) {
    await env.KV.put(throttleKey, "1", { expirationTtl: HEADER_ALERT_THROTTLE });
    await alertDirectors(
      env,
      [
        "**Application intake stopped — response sheet headers don't match.**",
        "Nothing was posted; no rows were read as applicants.",
        ...check.problems.map((p) => `• ${p}`),
        "Fix the form or update `src/config/columns.ts`, then re-run the backstop.",
      ].join("\n"),
    );
  }
  return false;
}

export async function renderCard(
  env: Env,
  row: ApplicationRow,
  state: CardState,
  waitingSince: Date,
  videos: VideoGroup[],
  decision: Decision,
  interview?: InterviewRecord,
  outcome?: OutcomeRecord,
  pending?: PendingOutcome,
  outcomesRevealed?: boolean,
): Promise<MessagePayload> {
  const [directorIds, minVotes] = await Promise.all([
    getDirectorIds(env),
    getNumber(env, "decision_min_votes"),
  ]);

  return buildIntakeMessage(row, {
    videos,
    state,
    dueAt: state === "awaiting" ? await dueAt(env, waitingSince) : undefined,
    sheetUrl: sheetRowUrl(env, row.row),
    decision,
    directorIds,
    minVotes,
    interview,
    outcome,
    pending,
    outcomesRevealed,
  });
}

/** Posts one row's card. Returns false if it was already carded. */
export async function postRow(
  env: Env,
  sheetRow: { row: number; values: string[] },
): Promise<boolean> {
  if (await getRecord(env, sheetRow.row)) return false;

  const row = parseRow(sheetRow.row, sheetRow.values);
  const state = initialState(row);
  const waitingSince = new Date();
  const videos = await collectVideoGroups(row.values);
  const decision = emptyDecision();

  const msg = await postToChannelByName(
    env,
    env.GUILD_COMMUNITY_ID,
    env.CH_AUDITION_REVIEW,
    await renderCard(env, row, state, waitingSince, videos, decision),
  );

  // A thread per applicant, so discussion lands beside their card. Best-effort:
  // a card without a thread is still a working card, and losing the card because
  // the thread failed would be the worse trade.
  let threadId: string | undefined;
  try {
    threadId = await createThreadOnMessage(
      env,
      msg.channelId,
      msg.id,
      `${row.name || `Row ${row.row}`} · ${row.applicantType || "applicant"}`,
    );
  } catch (err) {
    console.error("thread creation failed", row.row, err);
  }

  await putRecord(env, {
    row: row.row,
    messageId: msg.id,
    channelId: msg.channelId,
    ...(threadId ? { threadId } : {}),
    method: row.auditionMethod,
    state,
    waitingSince: waitingSince.toISOString(),
    values: sheetRow.values,
    videos,
    decision,
  });
  return true;
}

/**
 * Moves a card to a new state and edits the posted message in place, refreshing
 * the cached row and links from live data as it goes. Votes are preserved.
 *
 * `resetClock` restarts the wait - used by [Reopen], so a reopened card isn't
 * closed again by the next morning's sweep.
 */
export async function setCardState(
  env: Env,
  record: CardRecord,
  state: CardState,
  sheetRow: { row: number; values: string[] },
  resetClock = false,
): Promise<CardRecord> {
  const row = parseRow(record.row, sheetRow.values);
  const waitingSince = resetClock ? new Date() : new Date(record.waitingSince);
  const videos = await collectVideoGroups(sheetRow.values);
  const decision = record.decision ?? emptyDecision();

  await editMessage(
    env,
    record.channelId,
    record.messageId,
    await renderCard(
      env,
      row,
      state,
      waitingSince,
      [...videos, ...(record.auditionVideos ?? [])],
      decision,
      record.interview,
      record.outcome,
      record.pending,
      record.outcomesRevealed,
    ),
  );

  const updated: CardRecord = {
    ...record,
    state,
    // Only meaningful while closed. Left behind, it would send a later
    // timeout-closed card back to the wrong state on [Reopen].
    ...(state === "closed" ? {} : { closedFrom: undefined }),
    waitingSince: waitingSince.toISOString(),
    values: sheetRow.values,
    videos,
    decision,
  };
  await putRecord(env, updated);
  return updated;
}

/**
 * Re-renders a card from what is already cached - no sheet read, no link checks.
 * This is the path a vote or a feedback save takes.
 */
export async function refreshCard(env: Env, record: CardRecord): Promise<void> {
  if (!record.values) {
    throw new Error(
      `row ${record.row} has no cached row data — it predates vote support; re-run the daily job`,
    );
  }
  const row = parseRow(record.row, record.values);
  await editMessage(
    env,
    record.channelId,
    record.messageId,
    await renderCard(
      env,
      row,
      record.state,
      new Date(record.waitingSince),
      [...(record.videos ?? []), ...(record.auditionVideos ?? [])],
      record.decision ?? emptyDecision(),
      record.interview,
      record.outcome,
      record.pending,
      record.outcomesRevealed,
    ),
  );
}

/**
 * Closes a card because its outcome went out.
 *
 * Renders from the cache rather than re-reading the sheet: nothing about the
 * application changed, and re-checking every video link would spend
 * subrequests to redraw links the card is about to stop showing.
 */
export async function closeAfterOutcome(env: Env, record: CardRecord): Promise<void> {
  if (record.state === "closed") return;
  const updated: CardRecord = { ...record, state: "closed", closedFrom: record.state };
  await putRecord(env, updated);
  await refreshCard(env, updated);
}

/** Entry point for the onFormSubmit notifier. */
export async function handleFormSubmit(env: Env, row: number): Promise<void> {
  if (!(await isEnabled(env, "applications"))) return;

  const page = await readApplications(env, { rows: [row] });
  if (!(await headersOk(env, page))) return;

  const target = page.rows.find((r) => r.row === row);
  if (!target) {
    await alertDirectors(
      env,
      `Application intake: form submit notified row ${row}, but the sheet returned no such row.`,
    );
    return;
  }
  await postRow(env, target);
}
