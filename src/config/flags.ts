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
  | "email_sends"
  | "bookings"
  | "trainee_program"
  | "auditions"
  | "quiet_pings"
  | "simulate_votes"
  | "diamonds";

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
  /**
   * Trainee auditions. The doc makes this depend on trainee_program (rank 7),
   * which isn't built — so the loop runs without a cycle to attribute rows to,
   * and records no cycle_id rather than inventing one.
   */
  /**
   * The booking window: which sessions need a room, and recording the ones
   * that got one. Trainee sessions only — dance bookings are typed straight
   * into the sheet and aren't read yet.
   */
  bookings: false,
  /**
   * Cycles, the availability poll and the schedule. The doc makes auditions
   * depend on this; rank 12 was built first and runs without it, recording no
   * cycle_id rather than inventing one.
   */
  trainee_program: false,
  auditions: false,
  /**
   * Test-only. Puts two buttons on a trainee review card that cast every
   * director's ballot at once, so a settled vote or a split can be exercised
   * without three people. Off, and meant to stay off outside testing.
   */
  simulate_votes: false,
  /**
   * Test-only. Announcements still post, and still say what happened - they
   * just stop @-mentioning anyone. For rehearsing the flow without three
   * people's phones going off. Off, and meant to stay off in a real season:
   * the whole point of an announcement is that it reaches someone.
   */
  quiet_pings: false,
  /**
   * The Diamonds comp audition (DIAMONDS.md). Off until the announcement goes
   * out — while it's off every `/diamonds` subcommand refuses, including the
   * ones a dancer runs, which is what stops anyone registering for a process
   * that hasn't been announced yet.
   */
  diamonds: false,
};

export async function isEnabled(env: Env, flag: Flag): Promise<boolean> {
  const raw = await env.KV.get(`config:features.${flag}`);
  if (raw === null) return DEFAULTS[flag];
  return raw === "true" || raw === "1";
}
