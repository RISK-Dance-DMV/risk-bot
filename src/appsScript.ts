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

async function call<T>(
  env: Env,
  action: string,
  params: object = {},
): Promise<T> {
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Apps Script web apps 302 to googleusercontent; fetch follows it.
    redirect: "follow",
    body: JSON.stringify({ secret: env.APPS_SCRIPT_SECRET, action, params }),
  });

  const text = await res.text();
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
