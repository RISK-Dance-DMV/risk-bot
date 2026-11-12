/**
 * The Diamonds timeline and the numbers that govern it.
 *
 * Both read KV, so a date or the bar can change without a deploy — same
 * reasoning as config/settings.ts, and the bar especially: it is a parameter
 * precisely so it can move between cycles.
 *
 * Two timeline rather than five. The rounds used to run as cohort-wide phases,
 * which needed an opens and a closes each and made everyone wait for everyone;
 * see `DiamondsTimeline`. What's left is when the whole thing opens and when it
 * shuts, and every other date anyone cares about is derived from those plus the
 * numbers below.
 *
 * The timeline carry defaults rather than refusing when KV is empty. The
 * announcement quotes deadlines in prose and is written by hand, so these
 * numbers are the only machine-readable copy; a bot that disagrees with the
 * announcement about a deadline is the worse failure of the two, and an empty
 * KV would give us one silently. `/diamonds config` is what you read against
 * the announcement before turning the flag on.
 */
import { slotInstant } from "../applications/interviewSlot";
import { getNumber, getTimeZone } from "../config/settings";
import { DEFAULT_WEIGHTS, type DiamondsTimeline, type Weights } from "./audition";
import type { Env } from "../env";

/**
 * The day the announcement was written from. Change it and the announcement
 * together, or neither.
 */
const DEFAULT_DAYS = {
  opensAt: "2026-11-15",
} as const;

export type DateKey = keyof typeof DEFAULT_DAYS;

const KV_KEY: Record<DateKey, string> = {
  opensAt: "config:diamonds.opens",
};

/**
 * Opening is the start of its day, which is what the announcement means —
 * nobody reads "auditions open NOV 15" as "late on the 15th".
 */
const TIME_OF_DAY: Record<DateKey, string> = {
  opensAt: "00:01",
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turns the two configured days into instants. Pure, so the timezone handling
 * is testable without KV.
 *
 * A malformed override falls back to the default day rather than throwing: the
 * timeline is read on every single command, and a typo in one key should not
 * take the whole audition offline.
 */
export function resolveTimeline(
  raw: Partial<Record<DateKey, string | null>>,
  timeZone: string,
): DiamondsTimeline {
  const one = (key: DateKey): string => {
    const configured = raw[key]?.trim();
    const day = configured && ISO_DAY.test(configured) ? configured : DEFAULT_DAYS[key];
    if (configured && !ISO_DAY.test(configured)) {
      console.error(`${KV_KEY[key]} is not a YYYY-MM-DD date, using the default:`, configured);
    }
    return slotInstant(day, TIME_OF_DAY[key], timeZone).toISOString();
  };

  return { opensAt: one("opensAt") };
}


export async function getDiamondsTimeline(env: Env): Promise<DiamondsTimeline> {
  const keys = Object.keys(KV_KEY) as DateKey[];
  const [timeZone, ...values] = await Promise.all([
    getTimeZone(env),
    ...keys.map((key) => env.KV.get(KV_KEY[key])),
  ]);

  const raw: Partial<Record<DateKey, string | null>> = {};
  keys.forEach((key, index) => {
    raw[key] = values[index] as string | null;
  });
  return resolveTimeline(raw, timeZone);
}

/**
 * Every number a Diamonds decision depends on, read together.
 *
 * Passed down as a parameter from here on. Nothing below this line reads a
 * policy number for itself, so there is exactly one place to look when someone
 * asks what the bar was.
 */
export interface DiamondsPolicy {
  windowDays: number;
  bar: number;
  floor: number;
  requiredSteps: number;
  nudgeDays: number;
  headsUpDays: number;
  /** The turnaround promised after a submission, as a range. */
  reviewMinDays: number;
  /** And its slow end, which the derived Round 0 cutoff is computed from. */
  reviewMaxDays: number;
  /** Directors who must score a round before it settles. */
  minScores: number;
  /**
   * Days before an enforcement date that a renewal notice goes out, most
   * urgent first. Sorted here so nothing downstream has to care what order
   * they were read in.
   */
  noticeDays: number[];
  /** Months before someone who didn't pass may register again. */
  retryMonths: number;
  /** Days to finish all three rounds, counted from registration. */
  runDays: number;
  weights: Weights;
}

export async function getDiamondsPolicy(env: Env): Promise<DiamondsPolicy> {
  const [
    windowDays,
    bar,
    floor,
    requiredSteps,
    nudgeDays,
    headsUpDays,
    reviewMinDays,
    reviewMaxDays,
    minScores,
    noticeFirst,
    noticeSecond,
    noticeFinal,
    retryMonths,
    runDays,
  ] = await Promise.all([
    getNumber(env, "diamonds_window_days"),
    getNumber(env, "diamonds_bar"),
    getNumber(env, "diamonds_floor"),
    getNumber(env, "diamonds_required_steps"),
    getNumber(env, "diamonds_start_nudge_days"),
    getNumber(env, "diamonds_start_heads_up_days"),
    getNumber(env, "diamonds_review_min_days"),
    getNumber(env, "diamonds_review_max_days"),
    getNumber(env, "diamonds_min_scores"),
    getNumber(env, "diamonds_notice_first"),
    getNumber(env, "diamonds_notice_second"),
    getNumber(env, "diamonds_notice_final"),
    getNumber(env, "diamonds_retry_months"),
    getNumber(env, "diamonds_run_days"),
  ]);
  // Weights stay in code. They're the shape of the rubric rather than a
  // threshold — moving the bar is a cycle decision, re-weighting the dimensions
  // is a different rubric, and DIAMONDS-RUBRIC.md is where that argument goes.
  return {
    windowDays,
    bar,
    floor,
    requiredSteps,
    nudgeDays,
    headsUpDays,
    reviewMinDays,
    reviewMaxDays,
    minScores,
    // Deduplicated as well as sorted: setting two rungs to the same number is a
    // typo, and the honest reading of it is one rung rather than two notices on
    // the same morning.
    noticeDays: [...new Set([noticeFirst, noticeSecond, noticeFinal])].sort(
      (a, b) => a - b,
    ),
    retryMonths,
    runDays,
    weights: DEFAULT_WEIGHTS,
  };
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

/** Which numbers are set in KV and which are the built-in defaults. */
export type Source = "set" | "default";

export interface DiamondsConfigReadout {
  timeline: DiamondsTimeline;
  dateSources: Record<DateKey, Source>;
  policy: DiamondsPolicy;
  policySources: Record<string, Source>;
  timeZone: string;
  roleConfigured: boolean;
  enabled: boolean;
}

const POLICY_KEYS = [
  "diamonds_window_days",
  "diamonds_review_min_days",
  "diamonds_review_max_days",
  "diamonds_min_scores",
  "diamonds_bar",
  "diamonds_floor",
  "diamonds_required_steps",
  "diamonds_start_nudge_days",
  "diamonds_start_heads_up_days",
] as const;

/**
 * Everything the audition will run on, and where each value came from.
 *
 * Exists because the flag is not the last step of setup, it's the last step of
 * *several* — and flipping it with the timeline still on its defaults would
 * have the bot quoting timeline the announcement never mentioned. This is what you
 * read before flipping it, and it works while the flag is off.
 */
/**
 * The Diamonds role, or nothing.
 *
 * Nothing is a real answer and the callers have to treat it as one: the lapse
 * pass refuses to mark anybody as removed while this is unset, because a
 * membership recorded as revoked without the role actually coming off is the
 * one failure nobody would notice.
 */
export async function getDiamondsRoleId(env: Env): Promise<string | null> {
  const raw = await env.KV.get("config:role.diamonds");
  return raw?.trim() ? raw.trim() : null;
}

/**
 * The "Diamond Director" role, or nothing.
 *
 * Exemption from the renewal ladder is a property of being one of the two
 * people who judge it, not of being a director of the team — the director list
 * covers rank 7's cycles and rank 12's auditions too, and someone on it who
 * isn't judging Diamonds should be held to their date like anyone else.
 *
 * Nothing means **nobody is exempt**, which is the safe default in the same way
 * the sweep's empty director list was: an exemption nobody configured would be
 * a membership that silently never gets enforced, and a notice the two of them
 * can ignore costs nothing.
 */
export async function getDiamondDirectorRoleId(env: Env): Promise<string | null> {
  const raw = await env.KV.get("config:role.diamonds_director");
  return raw?.trim() ? raw.trim() : null;
}

export async function inspectDiamondsConfig(env: Env): Promise<DiamondsConfigReadout> {
  const dateKeys = Object.keys(KV_KEY) as DateKey[];
  const [timeZone, timeline, policy, enabledRaw, roleRaw, ...raw] = await Promise.all([
    getTimeZone(env),
    getDiamondsTimeline(env),
    getDiamondsPolicy(env),
    env.KV.get("config:features.diamonds"),
    env.KV.get("config:role.diamonds"),
    ...dateKeys.map((key) => env.KV.get(KV_KEY[key])),
    ...POLICY_KEYS.map((key) => env.KV.get(`config:${key}`)),
  ]);

  const dateSources = {} as Record<DateKey, Source>;
  dateKeys.forEach((key, index) => {
    dateSources[key] = raw[index] ? "set" : "default";
  });

  const policySources: Record<string, Source> = {};
  POLICY_KEYS.forEach((key, index) => {
    policySources[key] = raw[dateKeys.length + index] ? "set" : "default";
  });

  return {
    timeline,
    dateSources,
    policy,
    policySources,
    timeZone,
    roleConfigured: /^\d+$/.test((roleRaw ?? "").trim()),
    enabled: enabledRaw === "true" || enabledRaw === "1",
  };
}

/**
 * Writes the open date.
 *
 * Validated and then re-read rather than written blind: the whole point of
 * having this is to find out the timeline is wrong before a dancer does.
 */
export async function setDiamondsTimeline(
  env: Env,
  days: Partial<Record<DateKey, string>>,
): Promise<{ ok: true; changed: DateKey[] } | { ok: false; reason: string }> {
  const changed: DateKey[] = [];
  for (const [key, value] of Object.entries(days) as [DateKey, string][]) {
    const day = value.trim();
    if (!day) continue;
    if (!ISO_DAY.test(day)) {
      return { ok: false, reason: `\`${day}\` isn't a YYYY-MM-DD date.` };
    }
    if (Number.isNaN(new Date(`${day}T12:00:00Z`).getTime())) {
      return { ok: false, reason: `\`${day}\` isn't a real date.` };
    }
    changed.push(key);
  }
  if (changed.length === 0) {
    return { ok: false, reason: "Nothing to set — give me an open date, a close date, or both." };
  }

  for (const key of changed) {
    await env.KV.put(KV_KEY[key], days[key]!.trim());
  }
  return { ok: true, changed };
}
