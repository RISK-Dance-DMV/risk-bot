import type { Env } from "../env";

/**
 * Numeric config. No number governing a contestable decision lives in code
 * (design doc s3), so these read KV and can be changed without a deploy.
 *
 * TODO: back with the Config sheet alongside the flag registry.
 */
export type SettingKey =
  | "application_audition_days"
  | "decision_min_votes"
  | "draft_reping_hours";

const DEFAULTS: Record<SettingKey, number> = {
  /** Days a "RISK audition process" card waits for a submission before closing. */
  application_audition_days: 14,
  /** Doc open question 3's suggested default: "minimum 2". */
  decision_min_votes: 2,
  /** "A draft unactioned 48h before the date it references re-pings." */
  draft_reping_hours: 48,
};

export async function getNumber(env: Env, key: SettingKey): Promise<number> {
  const raw = await env.KV.get(`config:${key}`);
  if (raw === null) return DEFAULTS[key];
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULTS[key];
}
