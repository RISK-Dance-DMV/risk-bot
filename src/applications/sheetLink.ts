/**
 * Deep links into the response sheet. Pure.
 *
 * The gid is read from whatever URL is configured rather than assumed - the form
 * responses tab is rarely gid 0, and a wrong gid silently lands the reviewer on
 * the wrong tab at the right row number.
 */

const SPREADSHEET_PATH = /^(\/spreadsheets\/d\/[^/]+)/;

export function buildSheetRowUrl(
  configuredUrl: string,
  row: number,
): string | undefined {
  if (!configuredUrl || !Number.isInteger(row) || row < 1) return undefined;

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    return undefined;
  }

  const path = url.pathname.match(SPREADSHEET_PATH)?.[1];
  if (!path) return undefined;

  const gid =
    url.searchParams.get("gid") ??
    new URLSearchParams(url.hash.replace(/^#/, "")).get("gid") ??
    "0";

  return `${url.origin}${path}/edit?gid=${gid}#gid=${gid}&range=A${row}`;
}
