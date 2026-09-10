/**
 * Daily backstop (design doc s22).
 *
 * The form trigger fails silently and that looks exactly like "no applications
 * came in", so this reads the response sheet directly and posts anything that
 * never got a card.
 *
 * Two things keep it from being a firehose:
 *
 *   - A **floor**. On its first run against a sheet it adopts whatever is
 *     already there as history and cards none of it. A backstop is for catching
 *     the row that arrived while the trigger was broken, not for backfilling a
 *     season that already happened.
 *   - A **per-run cap**. Each card costs a Discord post plus one fetch per video
 *     link, and a Worker invocation has a hard subrequest budget. Past it, every
 *     remaining row fails at once. Leftovers are picked up on the next run.
 */
import { readApplications } from "../appsScript";
import { isEnabled } from "../config/flags";
import { getNumber } from "../config/settings";
import { alertDirectors } from "../discord/rest";
import type { Env } from "../env";
import { headersOk, postRow } from "./intake";

const MAX_ROWS = 500;

/** Highest row the backstop considers already handled. */
export const FLOOR_KEY = "app:backstop:floor";

export interface BackstopResult {
  skipped?: "flag_off" | "headers";
  scanned: number;
  posted: number;
  /** Set on the first run, when existing rows are adopted rather than carded. */
  adoptedAsHistory?: number;
  /** Rows above the floor still waiting, because the per-run cap was reached. */
  remaining?: number;
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

  const highestRow = page.rows.reduce((max, r) => Math.max(max, r.row), 1);
  const storedFloor = await env.KV.get(FLOOR_KEY);

  // First run: whatever is already in the sheet is history. Adopt it silently
  // rather than posting a card for every application ever received.
  if (storedFloor === null) {
    await env.KV.put(FLOOR_KEY, String(highestRow));
    return {
      scanned: page.rows.length,
      posted: 0,
      adoptedAsHistory: Math.max(0, page.rows.length),
    };
  }

  const floor = Number.parseInt(storedFloor, 10);
  const candidates = page.rows
    .filter((r) => r.row > (Number.isFinite(floor) ? floor : 0))
    .sort((a, b) => a.row - b.row);

  const cap = await getNumber(env, "backstop_max_per_run");
  const batch = candidates.slice(0, Math.max(1, cap));

  let posted = 0;
  let highestDone = floor;
  const failures: string[] = [];

  for (const row of batch) {
    try {
      if (await postRow(env, row)) posted++;
      // Only advance past rows that actually resolved, so a failure is retried
      // rather than stepped over.
      if (failures.length === 0) highestDone = row.row;
    } catch (err) {
      failures.push(`row ${row.row}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (highestDone > floor) await env.KV.put(FLOOR_KEY, String(highestDone));

  if (failures.length > 0) {
    await alertDirectors(
      env,
      [
        `**Application backstop: ${failures.length} row(s) failed to post.**`,
        ...failures.slice(0, 5).map((f) => `• ${f}`),
        "They'll be retried on the next run.",
      ].join("\n"),
    );
  }

  if (page.rows.length >= MAX_ROWS) {
    await alertDirectors(
      env,
      `Application backstop read the ${MAX_ROWS}-row cap. Older rows are no longer being checked — raise MAX_ROWS or archive the sheet.`,
    );
  }

  const remaining = candidates.length - batch.length;
  return {
    scanned: page.rows.length,
    posted,
    ...(remaining > 0 ? { remaining } : {}),
  };
}
