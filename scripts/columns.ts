/**
 * Shows what is actually in each column of the response sheet.
 *
 *   npm run columns              # application sheet
 *   npm run columns -- audition  # audition sheet
 *   npm run columns -- --row 118 # sample from a specific row
 *
 * src/config/columns.ts addresses fields by letter because the form's headers
 * repeat (design doc §22). That works right up until the form changes, and then
 * nothing errors — the card just quietly reads the wrong cell. This prints the
 * header and a sample value sitting at every letter, so a config drift is
 * something you can see instead of something you infer from a wrong card.
 *
 * Reads through Apps Script, same as the Worker. Needs APPS_SCRIPT_URL and
 * APPS_SCRIPT_SECRET in .dev.vars.
 */
import { readFileSync } from "node:fs";
import {
  AUDITION_METHOD_COLUMN,
  CARD_COLUMNS,
  PINNED,
  PINNED_HEADER_MATCH,
  VIDEO_COLUMNS,
} from "../src/config/columns";

interface SheetPage {
  headers: string[];
  rows: { row: number; values: string[] }[];
}

/**
 * The character class is deliberately not \\s: that matches newlines, so an
 * empty `KEY=` swallows the line break and returns the *next* line's contents.
 */
function devVar(key: string): string {
  try {
    const m = readFileSync(".dev.vars", "utf8").match(
      new RegExp(`^[^\\S\\n]*${key}[^\\S\\n]*=[^\\S\\n]*(.*)$`, "m"),
    );
    return (m?.[1] ?? "").trim();
  } catch {
    return "";
  }
}

/** 1 -> A, 27 -> AA. */
export function columnLetter(index1: number): string {
  let n = index1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "AQ" -> 42, as a 0-based index into a row's values. */
export function columnIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Contact details are redacted in the sample column. This tool is about the
 * shape of the sheet, and its output gets pasted into chats and issues.
 */
const PERSONAL = /e-?mail|name|phone|address/i;

function sampleCell(header: string, value: string): string {
  if (!value) return "";
  return PERSONAL.test(header) ? `(${value.length} chars, hidden)` : clip(value, 44);
}

/** Where each configured letter came from, so the dump can be annotated. */
function configuredColumns(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (column: string | null, label: string) => {
    if (!column) return;
    const at = map.get(column) ?? [];
    at.push(label);
    map.set(column, at);
  };

  for (const [key, column] of Object.entries(PINNED)) add(column, `pinned:${key}`);
  for (const c of CARD_COLUMNS) add(c.column, `card:${c.key}`);
  for (const v of VIDEO_COLUMNS) add(v.column, `video:${v.label}`);
  add(AUDITION_METHOD_COLUMN, "audition method");
  return map;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const type = args.includes("audition") ? "audition" : "application";
  const rowFlag = args.indexOf("--row");
  const wantRow = rowFlag >= 0 ? Number(args[rowFlag + 1]) : null;

  const url = devVar("APPS_SCRIPT_URL");
  const secret = devVar("APPS_SCRIPT_SECRET");
  const missing = [
    ["APPS_SCRIPT_URL", url],
    ["APPS_SCRIPT_SECRET", secret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(
      `\n.dev.vars is missing ${missing.join(" and ")}.\n\n` +
        "Both live in Cloudflare as Worker secrets, which are write-only — they\n" +
        "can't be read back. Copy them from the Apps Script editor instead:\n" +
        "  URL    — Deploy → Manage deployments → the web app URL\n" +
        "  SECRET — Project Settings → Script Properties → APPS_SCRIPT_SECRET\n\n" +
        ".dev.vars is gitignored. Paste them in yourself; I won't handle them.\n",
    );
    process.exit(1);
  }

  const action = type === "audition" ? "readAuditions" : "readApplications";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    redirect: "follow",
    body: JSON.stringify({
      secret,
      action,
      params: wantRow ? { rows: [wantRow] } : {},
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${clip(text, 300)}`);
    process.exit(1);
  }
  let parsed: { ok?: boolean; error?: string; data?: SheetPage };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`Apps Script didn't answer with JSON: ${clip(text, 200)}`);
    process.exit(1);
  }
  if (!parsed.ok || !parsed.data) {
    console.error(parsed.error ?? "unknown error");
    process.exit(1);
  }

  const { headers, rows } = parsed.data;
  // The newest row, because after a form change the older rows still hold the
  // old form's answers and would show an empty cell under a live question.
  const sample = rows[rows.length - 1];
  const configured = configuredColumns();

  console.log(
    `\n${type} sheet — ${headers.length} columns, ${rows.length} row(s) read` +
      (sample ? `, sampling row ${sample.row}` : ", no rows to sample"),
  );
  console.log("");

  for (let i = 0; i < headers.length; i++) {
    const letter = columnLetter(i + 1);
    const uses = configured.get(letter);
    const value = sampleCell(headers[i] ?? "", sample?.values[i] ?? "");
    const mark = uses ? "»" : " ";
    console.log(
      `${mark} ${letter.padStart(3)}  ${clip(headers[i] ?? "", 40).padEnd(40)}  ${value.padEnd(44)}  ${uses ? uses.join(", ") : ""}`,
    );
  }

  console.log("\nchecks");
  let problems = 0;
  const bad = (m: string) => {
    console.log(`  ✗ ${m}`);
    problems++;
  };

  for (const [letter, needle] of Object.entries(PINNED_HEADER_MATCH)) {
    const header = headers[columnIndex(letter)] ?? "";
    if (!header.toLowerCase().includes(needle.toLowerCase())) {
      bad(`${letter} should contain "${needle}" but its header is "${clip(header, 40)}"`);
    }
  }

  for (const [letter, uses] of configured) {
    if (columnIndex(letter) >= headers.length) {
      bad(`${letter} (${uses.join(", ")}) is past the last column of the sheet`);
    }
  }

  const videoish = headers
    .map((h, i) => ({ letter: columnLetter(i + 1), header: h }))
    .filter((c) => /video/i.test(c.header));
  const configuredVideo = new Set(VIDEO_COLUMNS.map((v) => v.column));
  for (const c of videoish) {
    if (!configuredVideo.has(c.letter)) {
      bad(`${c.letter} looks like a video question ("${clip(c.header, 40)}") but isn't in VIDEO_COLUMNS`);
    }
  }
  for (const v of VIDEO_COLUMNS) {
    if (!videoish.some((c) => c.letter === v.column)) {
      bad(`VIDEO_COLUMNS has ${v.column} ("${v.label}") but ${v.column}'s header is "${clip(headers[columnIndex(v.column)] ?? "", 40)}"`);
    }
  }

  if (problems === 0) console.log("  ✓ src/config/columns.ts matches the sheet");
  console.log("");
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
