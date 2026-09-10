/**
 * Closes "RISK audition process" cards that waited out the window without an
 * audition form submission.
 *
 * Note this is the one auto-transition in application intake; design doc s25 says
 * "nothing auto-lapses". It is kept reversible on purpose: the card edits in place
 * to a visible closed state and carries [Reopen], rather than disappearing.
 */
import { readApplications } from "../appsScript";
import { isEnabled } from "../config/flags";
import { alertDirectors } from "../discord/rest";
import type { Env } from "../env";
import {
  CARDED_PREFIX,
  dueAt,
  headersOk,
  setCardState,
  type CardRecord,
} from "./intake";

export interface StaleResult {
  skipped?: "flag_off" | "headers";
  awaiting: number;
  closed: number;
}

async function listRecords(env: Env): Promise<CardRecord[]> {
  const records: CardRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await env.KV.list({ prefix: CARDED_PREFIX, cursor });
    for (const key of page.keys) {
      const record = await env.KV.get<CardRecord>(key.name, "json");
      if (record) records.push(record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return records;
}

export async function runStaleSweep(env: Env): Promise<StaleResult> {
  if (!(await isEnabled(env, "applications"))) {
    return { skipped: "flag_off", awaiting: 0, closed: 0 };
  }

  const awaiting = (await listRecords(env)).filter((r) => r.state === "awaiting");
  if (awaiting.length === 0) return { awaiting: 0, closed: 0 };

  const now = Date.now();
  const expired: CardRecord[] = [];
  for (const record of awaiting) {
    const due = await dueAt(env, new Date(record.waitingSince));
    if (due.getTime() <= now) expired.push(record);
  }
  if (expired.length === 0) return { awaiting: awaiting.length, closed: 0 };

  const page = await readApplications(env, { rows: expired.map((r) => r.row) });
  if (!(await headersOk(env, page))) {
    return { skipped: "headers", awaiting: awaiting.length, closed: 0 };
  }

  let closed = 0;
  const failures: string[] = [];

  for (const record of expired) {
    const sheetRow = page.rows.find((r) => r.row === record.row);
    if (!sheetRow) {
      failures.push(`row ${record.row}: no longer in the response sheet`);
      continue;
    }
    try {
      await setCardState(env, record, "closed", sheetRow);
      closed++;
    } catch (err) {
      failures.push(
        `row ${record.row}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (failures.length > 0) {
    await alertDirectors(
      env,
      [
        `**Application sweep: ${failures.length} card(s) could not be closed.**`,
        ...failures.slice(0, 10).map((f) => `• ${f}`),
      ].join("\n"),
    );
  }

  return { awaiting: awaiting.length, closed };
}
