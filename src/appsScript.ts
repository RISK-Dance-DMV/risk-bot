/**
 * Worker -> Apps Script.
 *
 * Response sheets are read through Apps Script, never through a service account:
 * the triggers have to be Apps Script anyway, applications carry email and
 * personal data, and this keeps a second Google auth path (and the Node-only
 * googleapis SDK, which does not run on Workers) out of the Worker.
 */
import type { Env } from "./env";

export class AppsScriptError extends Error {}

/**
 * Apps Script reads take a couple of seconds. Anything past this is hung, not
 * slow - usually a deployment that needs re-authorising, which answers by never
 * answering. Failing here beats waiting out Cloudflare's 100-second 524, which
 * says nothing about the cause.
 */
const APPS_SCRIPT_TIMEOUT_MS = 25_000;

async function call<T>(
  env: Env,
  action: string,
  params: object = {},
): Promise<T> {
  if (!env.APPS_SCRIPT_URL) {
    throw new AppsScriptError(`${action}: APPS_SCRIPT_URL secret is not set`);
  }

  let res: Response;
  try {
    res = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Apps Script web apps 302 to googleusercontent; fetch follows it.
      redirect: "follow",
      body: JSON.stringify({ secret: env.APPS_SCRIPT_SECRET, action, params }),
      signal: AbortSignal.timeout(APPS_SCRIPT_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new AppsScriptError(
      timedOut
        ? `${action}: Apps Script didn't answer within ${APPS_SCRIPT_TIMEOUT_MS / 1000}s. Usually the web app needs re-authorising after a code change — open the editor, run any function once, accept the prompts, then redeploy the same deployment.`
        : `${action}: couldn't reach Apps Script: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  if (res.status === 524 || res.status === 504) {
    throw new AppsScriptError(
      `${action}: Apps Script timed out (HTTP ${res.status}). Usually the web app needs re-authorising after a code change, or it's pointed at a deployment that no longer works.`,
    );
  }
  if (!res.ok) throw new AppsScriptError(`${action}: HTTP ${res.status}: ${text.slice(0, 500)}`);

  let parsed: { ok?: boolean; error?: string; data?: T };
  try {
    parsed = JSON.parse(text);
  } catch {
    // An HTML body here almost always means the deployment is not "Anyone" access.
    throw new AppsScriptError(`${action}: non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!parsed.ok) throw new AppsScriptError(parsed.error ?? "unknown error");
  return parsed.data as T;
}

export interface SheetRow {
  row: number;
  values: string[];
}

export interface SheetPage {
  headers: string[];
  rows: SheetRow[];
}

export interface ReadParams {
  rows?: number[];
  fromRow?: number;
  limit?: number;
}

export function readApplications(env: Env, params: ReadParams): Promise<SheetPage> {
  return call<SheetPage>(env, "readApplications", params);
}

export function readAuditions(env: Env, params: ReadParams): Promise<SheetPage> {
  return call<SheetPage>(env, "readAuditions", params);
}

// ------------------------------------------------------ rank 21: registration

export interface FormConfig {
  formId: string;
  formTitle: string;
  formUrl: string;
  destinationId: string;
  sheetName: string;
  registeredAt: string;
  /** Audition forms only: the column submissions are matched on. */
  emailColumn?: string;
}

/** Read-only. Nothing is written or installed, so the caller can still refuse. */
export interface FormInspection {
  formId: string;
  formTitle: string;
  formUrl: string;
  destinationId: string;
  spreadsheetName: string;
  sheetName: string;
  headers: string[];
  responseCount: number;
}

export function inspectForm(env: Env, url: string): Promise<FormInspection> {
  return call<FormInspection>(env, "inspectForm", { url });
}

export interface CommitFormParams {
  type: string;
  formId: string;
  formTitle: string;
  formUrl: string;
  destinationId: string;
  sheetName: string;
  emailColumn?: string;
}

export function commitForm(
  env: Env,
  params: CommitFormParams,
): Promise<{ config: FormConfig; previous: FormConfig | null }> {
  return call(env, "commitForm", params);
}

export function getForms(
  env: Env,
): Promise<{ application: FormConfig | null; audition: FormConfig | null }> {
  return call(env, "getForms", {});
}

// ------------------------------------------------------------ rank 27: email

export function readTemplates(env: Env): Promise<SheetPage> {
  return call<SheetPage>(env, "readTemplates", {});
}

export interface SendEmailResult {
  to: string;
  /** Consumer Gmail allows 100 recipients/day. */
  remainingQuota: number;
}

export function sendEmail(
  env: Env,
  params: { to: string; subject: string; body: string },
): Promise<SendEmailResult> {
  return call<SendEmailResult>(env, "sendEmail", params);
}

// -------------------------------------------------------- rank 24: interviews

export interface InterviewEvent {
  eventId: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  guests?: string[];
}

export function createInterviewEvent(
  env: Env,
  params: {
    /** Absolute instant, resolved against config:timezone by the caller. */
    startsAt: string;
    date: string;
    time: string;
    durationMinutes: number;
    guestEmail: string;
    /** Directors and the RISK account, alongside the applicant. */
    guests: string[];
    title: string;
    description: string;
  },
): Promise<InterviewEvent> {
  return call<InterviewEvent>(env, "createInterviewEvent", params);
}
