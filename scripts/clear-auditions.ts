/**
 * Clears stored trainee auditions (design doc rank 12).
 *
 *   npm run clear-auditions          # shows what it would delete
 *   npm run clear-auditions -- --yes # deletes it
 *
 * Exists because the obvious command is dangerous. Rank 12's keys and the
 * application form's keys share an `aud:` prefix:
 *
 *   aud:rec:      aud:current:      aud:thread:      trainee auditions
 *   aud:seen:     aud:reconcile:floor               the AUDITION FORM
 *
 * Wiping `aud:` would make the form reconcile re-post cards for submissions it
 * already matched, and reset its floor so it rescans the whole sheet. This
 * script can only ever see the three prefixes below, so that can't happen by
 * mistyping a prefix at 1am.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The only prefixes this script will ever touch. */
const PREFIXES = ["aud:rec:", "aud:current:", "aud:thread:"] as const;

/** Same prefix, different feature. Named so the reason is written down. */
const NEVER = ["aud:seen:", "aud:reconcile:"] as const;

function wrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function listKeys(prefix: string): string[] {
  const raw = wrangler([
    "kv:key",
    "list",
    "--binding=KV",
    `--prefix=${prefix}`,
    "--preview",
    "false",
  ]);
  const parsed = JSON.parse(raw) as { name: string }[];
  return parsed.map((k) => k.name);
}

function main(): void {
  const confirmed = process.argv.includes("--yes");

  const found: string[] = [];
  for (const prefix of PREFIXES) {
    const keys = listKeys(prefix);
    console.log(`  ${prefix.padEnd(14)} ${keys.length}`);
    found.push(...keys);
  }

  // Belt and braces: the prefixes above can't produce these, and if they ever
  // did, stopping is the right answer.
  const forbidden = found.filter((k) => NEVER.some((p) => k.startsWith(p)));
  if (forbidden.length > 0) {
    console.error(`\nRefusing: these belong to the application form, not trainees:`);
    for (const key of forbidden) console.error(`  ${key}`);
    process.exit(1);
  }

  if (found.length === 0) {
    console.log("\nNothing stored.\n");
    return;
  }

  if (!confirmed) {
    console.log(`\n${found.length} key(s). Re-run with --yes to delete:`);
    console.log("  npm run clear-auditions -- --yes\n");
    return;
  }

  const file = join(mkdtempSync(join(tmpdir(), "risk-aud-")), "keys.json");
  writeFileSync(file, JSON.stringify(found));
  wrangler(["kv:bulk", "delete", file, "--binding=KV", "--preview", "false", "--force"]);

  console.log(`\nDeleted ${found.length} key(s).`);
  console.log(
    "\nThe Discord messages are still there — delete the proposal cards in\n" +
      "#coaches-bot-confirmation and any review cards in #audition-review.\n" +
      "Deleting a message takes its thread with it. Until then their buttons\n" +
      'will answer "that audition is no longer on file".\n',
  );
}

main();
