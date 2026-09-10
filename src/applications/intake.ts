import { readApplications, type SheetPage } from "../appsScript";
import type { AuditionMethod } from "../config/columns";
import { getDirectorIds } from "../config/directors";
import { isEnabled } from "../config/flags";
import { getNumber } from "../config/settings";
import { alertDirectors, editMessage, postToChannelByName } from "../discord/rest";
import type { MessagePayload } from "../discord/types";
import type { Env } from "../env";
import { buildIntakeMessage, type CardState } from "./card";
import { emptyDecision, type Decision } from "./decision";
import { parseRow, verifyPinnedHeaders, type ApplicationRow } from "./fields";
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
  /** ISO. Restarts on reopen - the clock measures the current wait, not the first. */
  waitingSince: string;
  values?: string[];
  videos?: VideoGroup[];
  decision?: Decision;
}

export const CARDED_PREFIX = "app:carded:";
const cardedKey = (row: number) => `${CARDED_PREFIX}${row}`;

export async function getRecord(env: Env, row: number): Promise<CardRecord | null> {
  return env.KV.get<CardRecord>(cardedKey(row), "json");
}

export async function putRecord(env: Env, record: CardRecord): Promise<void> {
  await env.KV.put(cardedKey(record.row), JSON.stringify(record), {
    expirationTtl: CARDED_TTL,
  });
}

export function sheetRowUrl(env: Env, row: number): string | undefined {
  return buildSheetRowUrl(env.APPLICATION_SHEET_URL ?? "", row);
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

  await putRecord(env, {
    row: row.row,
    messageId: msg.id,
    channelId: msg.channelId,
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
    await renderCard(env, row, state, waitingSince, videos, decision),
  );

  const updated: CardRecord = {
    ...record,
    state,
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
      record.videos ?? [],
      record.decision ?? emptyDecision(),
    ),
  );
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
