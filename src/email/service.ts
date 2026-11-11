/**
 * Sending (design doc rank 27).
 *
 * "The only truly irreversible action in the system." Every send is gated twice:
 * by the email_sends flag, and by a human clicking [Approve] on a draft that
 * shows the exact text.
 */
import { readTemplates, sendEmail, type SendEmailResult } from "../appsScript";
import { isEnabled } from "../config/flags";
import { tidyBody } from "./templates";
import { alertDirectors } from "../discord/rest";
import type { Env } from "../env";
import {
  findTemplate,
  parseTemplates,
  renderTemplate,
  type RenderResult,
  type Template,
} from "./templates";

/** Warn while there is still room to finish a round, not after it fails. */
const LOW_QUOTA = 10;

export async function loadTemplates(env: Env): Promise<Template[]> {
  return parseTemplates(await readTemplates(env));
}

/**
 * Renders a template ready for a draft. Fails loudly on a missing template or an
 * unfilled merge field, rather than producing a plausible-looking message.
 */
export async function renderForSend(
  env: Env,
  key: string,
  merge: Record<string, string>,
): Promise<RenderResult> {
  let templates: Template[];
  try {
    templates = await loadTemplates(env);
  } catch (err) {
    return {
      ok: false,
      reason: `Couldn't read the templates sheet: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const template = findTemplate(templates, key);
  if (!template) {
    const available = templates.map((t) => t.key).join(", ") || "none";
    return { ok: false, reason: `No template named "${key}". Available: ${available}.` };
  }
  return renderTemplate(template, merge);
}

export type DeliveryResult =
  | { ok: true; result: SendEmailResult }
  | { ok: false; reason: string };

/**
 * The actual send. Nothing else in the codebase calls MailApp.
 */
export async function deliverEmail(
  env: Env,
  message: { to: string; subject: string; body: string },
): Promise<DeliveryResult> {
  if (!(await isEnabled(env, "email_sends"))) {
    return {
      ok: false,
      reason:
        "`features.email_sends` is off, so nothing was sent and no status advanced. The draft is still waiting.",
    };
  }

  let result: SendEmailResult;
  try {
    // Again here, not only in renderTemplate: a hand-edited draft reaches this
    // point without ever having been through the renderer.
    result = await sendEmail(env, { ...message, body: tidyBody(message.body) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Failures post to #directors-bot-confirmation (design doc s27).
    await alertDirectors(
      env,
      `**Email send failed.**\nTo: \`${message.to}\`\nSubject: ${message.subject}\n${reason}`,
    );
    return { ok: false, reason };
  }

  if (result.remainingQuota <= LOW_QUOTA) {
    await alertDirectors(
      env,
      `Gmail send quota is down to **${result.remainingQuota}** for today.`,
    );
  }
  return { ok: true, result };
}
