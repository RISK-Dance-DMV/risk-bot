import type { Env } from "../env";

/**
 * Feature flags. Today these read KV so they can be flipped without a deploy
 * (design doc s6.5: "a Config edit, not an emergency deploy").
 *
 * TODO: back this with the Config sheet once the data seam exists. Keep every
 * caller behind isEnabled() so that swap is one function.
 */
export type Flag =
  | "applications"
  | "roster_readout"
  | "activity_sync"
  | "inactivity_sweep"
  | "email_sends";

const DEFAULTS: Record<Flag, boolean> = {
  applications: false,
  roster_readout: false,
  activity_sync: false,
  inactivity_sweep: false,
  /**
   * "The only truly irreversible action in the system." Gates every send, and
   * every status transition that assumes an email went out. Turn on last.
   */
  email_sends: false,
};

export async function isEnabled(env: Env, flag: Flag): Promise<boolean> {
  const raw = await env.KV.get(`config:features.${flag}`);
  if (raw === null) return DEFAULTS[flag];
  return raw === "true" || raw === "1";
}
