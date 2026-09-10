/**
 * /form register (design doc rank 21).
 *
 * Twice a year, per form. Inspection is read-only, so a form whose headers don't
 * check out is refused with nothing written and no trigger installed.
 */
import { verifyPinnedHeaders } from "../applications/fields";
import { commitForm, inspectForm, type FormConfig } from "../appsScript";
import { resolveEmailColumn, type FormType } from "../config/forms";
import type { MessagePayload } from "../discord/types";
import type { Env } from "../env";

function refuse(lines: string[]): MessagePayload {
  return { content: ["❌ **Not registered.**", ...lines].join("\n") };
}

function describePrevious(previous: FormConfig | null, formId: string): string {
  if (!previous) return "No form was registered for this type before.";
  if (previous.formId === formId) {
    return `Same form as before — the trigger was reinstalled, registered ${previous.registeredAt.slice(0, 10)}.`;
  }
  return `Retired \`${previous.formId}\`, live since ${previous.registeredAt.slice(0, 10)}.`;
}

export async function handleFormRegister(
  env: Env,
  type: FormType,
  url: string,
): Promise<MessagePayload> {
  const inspection = await inspectForm(env, url).catch((err) => err as Error);
  if (inspection instanceof Error) return refuse([inspection.message]);

  let emailColumn: string | undefined;

  if (type === "application") {
    // Re-verify C/D/E immediately and refuse on mismatch, naming what it found.
    const check = verifyPinnedHeaders(inspection.headers);
    if (!check.ok) {
      return refuse([
        `\`${inspection.formTitle}\` writes to **${inspection.spreadsheetName} › ${inspection.sheetName}**, but its pinned columns don't match:`,
        ...check.problems.map((p) => `• ${p}`),
        "Fix the form's question order, or update `src/config/columns.ts` and redeploy.",
      ]);
    }
  } else {
    const resolved = resolveEmailColumn(inspection.headers);
    if (!resolved.column) {
      return refuse([
        `\`${inspection.formTitle}\` has no column to match submissions on — ${resolved.detail}.`,
        "Audition submissions are matched to applications by email, so the form must collect one.",
      ]);
    }
    emailColumn = resolved.column;
  }

  const committed = await commitForm(env, {
    type,
    formId: inspection.formId,
    formTitle: inspection.formTitle,
    formUrl: inspection.formUrl,
    destinationId: inspection.destinationId,
    sheetName: inspection.sheetName,
    ...(emailColumn ? { emailColumn } : {}),
  }).catch((err) => err as Error);
  if (committed instanceof Error) return refuse([committed.message]);

  const backlog =
    inspection.responseCount === 0
      ? "No responses on it yet."
      : type === "application"
        ? `${inspection.responseCount} existing response(s) — tomorrow's backstop will card any that were never posted.`
        : `${inspection.responseCount} existing response(s) — tomorrow's reconcile will match them to applications.`;

  return {
    content: [
      `✅ **Registered the ${type} form.**`,
      `**${inspection.formTitle}**`,
      `Responses → ${inspection.spreadsheetName} › \`${inspection.sheetName}\``,
      ...(emailColumn ? [`Matching submissions on ${emailColumn}.`] : []),
      "Trigger installed.",
      backlog,
      describePrevious(committed.previous, inspection.formId),
    ].join("\n"),
  };
}
