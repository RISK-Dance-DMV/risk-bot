/**
 * Daily backstop (design doc s22).
 *
 * The form trigger fails silently and that looks exactly like "no applications
 * came in", so this reads the response sheet directly and posts anything that
 * never got a card.
 */
import { readApplications } from "../appsScript";
import { isEnabled } from "../config/flags";
import { alertDirectors } from "../discord/rest";
import type { Env } from "../env";
import { headersOk, postRow } from "./intake";

const MAX_ROWS = 500;

export interface BackstopResult {
  skipped?: "flag_off" | "headers";
  scanned: number;
  posted: number;
}

export async function runBackstop(env: Env): Promise<BackstopResult> {
  // Crons check their flag first and exit silently - no post, no log line.
  if (!(await isEnabled(env, "applications"))) {
    return { skipped: "flag_off", scanned: 0, posted: 0 };
  }

  const page = await readApplications(env, { fromRow: 2, limit: MAX_ROWS });
  if (!(await headersOk(env, page))) {
    return { skipped: "headers", scanned: page.rows.length, posted: 0 };
  }

  let posted = 0;
  const failures: string[] = [];

  for (const row of page.rows) {
    try {
      if (await postRow(env, row)) posted++;
    } catch (err) {
      failures.push(`row ${row.row}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    await alertDirectors(
      env,
      [
        `**Application backstop: ${failures.length} row(s) failed to post.**`,
        ...failures.slice(0, 10).map((f) => `• ${f}`),
      ].join("\n"),
    );
  }

  if (page.rows.length >= MAX_ROWS) {
    await alertDirectors(
      env,
      `Application backstop read the ${MAX_ROWS}-row cap. Older rows are no longer being checked — raise MAX_ROWS or archive the sheet.`,
    );
  }

  return { scanned: page.rows.length, posted };
}
