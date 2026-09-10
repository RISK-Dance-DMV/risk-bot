/**
 * Command gating, layer 3 (design doc s2).
 *
 * "Role check in the handler, ephemeral decline on failure. Never use a
 * permission bit as a proxy for 'director.'" Plus a channel allowlist.
 */
import { resolveChannelId } from "../discord/rest";
import type { Interaction } from "../discord/types";
import type { Env } from "../env";

/** Returns a decline reason, or null when the caller may proceed. */
export async function declineReason(
  env: Env,
  interaction: Interaction,
  channelName: string,
): Promise<string | null> {
  if (interaction.guild_id !== env.GUILD_DANCE_ID) {
    return "That command only works in the dance server.";
  }

  const roles = interaction.member?.roles ?? [];
  if (!env.ROLE_DIRECTOR_ID) {
    return "ROLE_DIRECTOR_ID isn't configured, so I can't check who you are. Refusing.";
  }
  if (!roles.includes(env.ROLE_DIRECTOR_ID)) {
    return "That command is directors only.";
  }

  let allowed: string;
  try {
    allowed = await resolveChannelId(env, env.GUILD_DANCE_ID, channelName);
  } catch (err) {
    return `Couldn't resolve #${channelName}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (interaction.channel_id !== allowed) {
    return `Run that in #${channelName}.`;
  }

  return null;
}
