/**
 * Audition form submissions (design doc ranks 21 + 22).
 *
 * Only "RISK audition process" applicants audition through a separate form. A
 * submission flips their card off `awaiting`, which is what stops the 14-day
 * sweep from closing someone who did in fact audition.
 */
import { getForms, readApplications, readAuditions, type SheetPage } from "../appsScript";
import { PINNED } from "../config/columns";
import { isEnabled } from "../config/flags";
import { alertDirectors } from "../discord/rest";
import type { Env } from "../env";
import { cell, parseRow } from "./fields";
import { announceOnCard, getRecord, headersOk, setCardState } from "./intake";

const SEEN_TTL = 400 * 24 * 60 * 60;
const MAX_ROWS = 500;

const seenKey = (row: number) => `aud:seen:${row}`;

export type AuditionOutcome =
  /** Card moved awaiting -> submitted. */
  | "matched"
  /** Card had already been closed; the late submission reopens it as submitted. */
  | "matched_late"
  | "already_submitted"
  /** No application row carries that email. */
  | "unmatched"
  /** Matched an applicant who chose the video-submission route instead. */
  | "wrong_method"
  | "no_card"
  | "no_email";

export interface AuditionResult {
  row: number;
  email: string;
  outcome: AuditionOutcome;
}

const PROBLEM_OUTCOMES: AuditionOutcome[] = ["unmatched", "no_email", "no_card"];

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * email -> application row. On duplicates the highest row wins, so a re-applicant
 * is matched to their most recent application.
 */
export function indexByEmail(page: SheetPage): Map<string, number> {
  const byEmail = new Map<string, number>();
  for (const row of page.rows) {
    const email = normalizeEmail(cell(row.values, PINNED.email));
    if (!email) continue;
    const existing = byEmail.get(email);
    if (existing === undefined || row.row > existing) byEmail.set(email, row.row);
  }
  return byEmail;
}

async function processRow(
  env: Env,
  auditionRow: { row: number; values: string[] },
  emailColumn: string,
  applications: SheetPage,
  byEmail: Map<string, number>,
): Promise<AuditionResult> {
  const email = normalizeEmail(cell(auditionRow.values, emailColumn));
  const result = (outcome: AuditionOutcome): AuditionResult => ({
    row: auditionRow.row,
    email,
    outcome,
  });

  if (!email) return result("no_email");

  const applicationRow = byEmail.get(email);
  if (applicationRow === undefined) return result("unmatched");

  const record = await getRecord(env, applicationRow);
  if (!record) return result("no_card");
  if (record.method !== "risk_process") return result("wrong_method");
  if (record.state === "submitted") return result("already_submitted");

  const sheetRow = applications.rows.find((r) => r.row === applicationRow);
  if (!sheetRow) return result("no_card");

  const wasClosed = record.state === "closed";
  const updated = await setCardState(env, record, "submitted", sheetRow);

  // The card flipping to `submitted` is the moment there's something to vote on,
  // and an edit notifies nobody.
  const name = parseRow(applicationRow, sheetRow.values).name || `row ${applicationRow}`;
  await announceOnCard(
    env,
    updated,
    wasClosed
      ? `**${name}**'s audition arrived after their card had closed — reopened, and ready to vote on.`
      : `**${name}**'s audition arrived. Ready to vote on.`,
  );

  return result(wasClosed ? "matched_late" : "matched");
}

function summarize(results: AuditionResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    if (r.outcome === "unmatched") {
      lines.push(`• row ${r.row}: \`${r.email}\` matches no application`);
    } else if (r.outcome === "no_email") {
      lines.push(`• row ${r.row}: no email on the submission`);
    } else if (r.outcome === "no_card") {
      lines.push(`• row ${r.row}: \`${r.email}\` has an application but no card`);
    }
  }
  return lines;
}

async function loadApplications(
  env: Env,
): Promise<{ page: SheetPage; byEmail: Map<string, number> } | null> {
  const page = await readApplications(env, { fromRow: 2, limit: MAX_ROWS });
  if (!(await headersOk(env, page))) return null;
  return { page, byEmail: indexByEmail(page) };
}

async function auditionEmailColumn(env: Env): Promise<string | null> {
  const forms = await getForms(env);
  return forms.audition?.emailColumn ?? null;
}

/**
 * Runs the given audition rows and records what happened, so a submission that
 * matched nobody is reported once rather than every morning.
 */
async function run(
  env: Env,
  emailColumn: string,
  auditionRows: { row: number; values: string[] }[],
): Promise<AuditionResult[]> {
  if (auditionRows.length === 0) return [];

  const applications = await loadApplications(env);
  if (!applications) return [];

  const results: AuditionResult[] = [];
  for (const auditionRow of auditionRows) {
    try {
      const result = await processRow(
        env,
        auditionRow,
        emailColumn,
        applications.page,
        applications.byEmail,
      );
      results.push(result);
      await env.KV.put(seenKey(result.row), result.outcome, { expirationTtl: SEEN_TTL });
    } catch (err) {
      console.error("audition row failed", auditionRow.row, err);
    }
  }

  const problems = summarize(results);
  if (problems.length > 0) {
    await alertDirectors(
      env,
      [
        `**${problems.length} audition submission(s) couldn't be matched.**`,
        "Their application cards will close on schedule unless this is sorted.",
        ...problems.slice(0, 10),
      ].join("\n"),
    );
  }
  return results;
}

/** Entry point for the audition form's onFormSubmit notifier. */
export async function handleAuditionSubmit(env: Env, row: number): Promise<void> {
  if (!(await isEnabled(env, "applications"))) return;

  const emailColumn = await auditionEmailColumn(env);
  if (!emailColumn) {
    await alertDirectors(
      env,
      `An audition submission arrived (row ${row}) but no audition form is registered. Run \`/form register\`.`,
    );
    return;
  }

  const page = await readAuditions(env, { rows: [row] });
  const target = page.rows.find((r) => r.row === row);
  if (!target) return;

  await run(env, emailColumn, [target]);
}

export interface ReconcileResult {
  skipped?: "flag_off" | "not_registered";
  scanned: number;
  matched: number;
}

/**
 * Daily backstop for the audition trigger. Without this, a failed trigger looks
 * exactly like "nobody auditioned" and the sweep closes them at 14 days.
 */
export async function runAuditionReconcile(env: Env): Promise<ReconcileResult> {
  if (!(await isEnabled(env, "applications"))) {
    return { skipped: "flag_off", scanned: 0, matched: 0 };
  }

  const emailColumn = await auditionEmailColumn(env);
  if (!emailColumn) return { skipped: "not_registered", scanned: 0, matched: 0 };

  const page = await readAuditions(env, { fromRow: 2, limit: MAX_ROWS });

  const unseen: { row: number; values: string[] }[] = [];
  for (const row of page.rows) {
    if (!(await env.KV.get(seenKey(row.row)))) unseen.push(row);
  }

  const results = await run(env, emailColumn, unseen);
  const matched = results.filter(
    (r) => r.outcome === "matched" || r.outcome === "matched_late",
  ).length;

  return { scanned: page.rows.length, matched };
}
