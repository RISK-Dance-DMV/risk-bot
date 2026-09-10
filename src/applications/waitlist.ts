/**
 * Bringing waitlisted applicants back round.
 *
 * Two triggers, because the real one isn't available yet:
 *
 *   - `/waitlist open subunit:` — a director says a spot opened. Manual, but
 *     accurate, and it needs no roster data.
 *   - a revisit date — anyone sitting longer than `waitlist_revisit_days`
 *     resurfaces on their own, so nobody is quietly forgotten.
 *
 * Capacity-triggered resurfacing needs roster counts (ranks 1–2), which don't
 * exist. When they do, this same digest gets a third caller.
 */
import { getNumber } from "../config/settings";
import { SUBUNITS, type Subunit } from "../config/subunits";
import { postToChannelByName } from "../discord/rest";
import type { MessagePayload } from "../discord/types";
import type { Env } from "../env";
import { parseRow } from "./fields";
import { CARDED_PREFIX, putRecord, type CardRecord } from "./intake";

const DAY = 24 * 60 * 60 * 1000;

export function isWaitlisted(record: CardRecord): boolean {
  return record.outcome?.outcome === "waitlisted";
}

/** Everyone currently waitlisted, optionally narrowed to one subunit. */
export async function waitlisted(
  env: Env,
  subunit?: Subunit,
): Promise<CardRecord[]> {
  const found: CardRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await env.KV.list({ prefix: CARDED_PREFIX, cursor });
    for (const key of page.keys) {
      const record = await env.KV.get<CardRecord>(key.name, "json");
      if (!record || !isWaitlisted(record)) continue;
      if (subunit && !(record.outcome?.subunits ?? []).includes(subunit)) continue;
      found.push(record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return found.sort((a, b) => (a.outcome?.at ?? "").localeCompare(b.outcome?.at ?? ""));
}

function describe(env: Env, record: CardRecord): string {
  const name = record.values ? parseRow(record.row, record.values).name : "";
  const placement = record.outcome?.subunits?.join(", ") ?? "—";
  const since = record.outcome?.at?.slice(0, 10) ?? "?";
  const link = `https://discord.com/channels/${env.GUILD_COMMUNITY_ID}/${record.channelId}/${record.messageId}`;
  return `• **${name || `row ${record.row}`}** — ${placement}, waitlisted since ${since}\n  ${link}`;
}

/**
 * Posts the digest. Deliberately links to existing cards rather than making new
 * ones: the card already carries the three outcome buttons, so there is one
 * place a decision gets made.
 */
export async function postWaitlistDigest(
  env: Env,
  records: CardRecord[],
  heading: string,
): Promise<void> {
  if (records.length === 0) return;

  await postToChannelByName(env, env.GUILD_COMMUNITY_ID, env.CH_AUDITION_REVIEW, {
    content: [heading, "", ...records.map((r) => describe(env, r))].join("\n"),
    allowed_mentions: { parse: [] },
  });
}

/** `/waitlist open subunit:` — a spot opened, show me who's waiting for it. */
export async function openSpot(env: Env, subunit: Subunit): Promise<MessagePayload> {
  const records = await waitlisted(env, subunit);
  if (records.length === 0) {
    return { content: `Nobody is waitlisted for **${subunit}**.` };
  }

  await postWaitlistDigest(
    env,
    records,
    `🎴 **A ${subunit} spot opened** — ${records.length} waitlisted, oldest first. Decide on their cards.`,
  );
  return {
    content: `Posted ${records.length} waitlisted ${subunit} applicant(s) in #${env.CH_AUDITION_REVIEW}.`,
  };
}

export interface RevisitResult {
  waitlisted: number;
  resurfaced: number;
}

/**
 * Daily. Surfaces anyone past their revisit date and pushes the date out, so a
 * card resurfaces on a cycle rather than every morning.
 */
export async function runWaitlistRevisit(env: Env): Promise<RevisitResult> {
  const all = await waitlisted(env);
  const now = Date.now();

  const due = all.filter((r) => {
    const at = r.outcome?.revisitAt;
    return !!at && new Date(at).getTime() <= now;
  });

  if (due.length === 0) return { waitlisted: all.length, resurfaced: 0 };

  await postWaitlistDigest(
    env,
    due,
    `⏸️ **${due.length} waitlisted applicant(s) due another look.**`,
  );

  const days = await getNumber(env, "waitlist_revisit_days");
  const next = new Date(now + days * DAY).toISOString();
  for (const record of due) {
    if (!record.outcome) continue;
    await putRecord(env, { ...record, outcome: { ...record.outcome, revisitAt: next } });
  }

  return { waitlisted: all.length, resurfaced: due.length };
}

export function isSubunit(value: string): value is Subunit {
  return (SUBUNITS as readonly string[]).includes(value);
}
