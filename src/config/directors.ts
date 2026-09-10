import type { Env } from "../env";

/**
 * The director roster, as explicit Discord IDs.
 *
 * Not a role check: design doc s2 rules out privileged intents, and enumerating a
 * role's members over REST needs GUILD_MEMBERS. "Once all directors have
 * submitted" needs a denominator, so the roster is stated rather than derived.
 * An explicit ID list is also a stricter check than a role, not a looser one -
 * it is never a permission bit standing in for "director".
 *
 *   wrangler kv:key put --binding=KV config:director_ids "111,222,333" --preview false
 */
export async function getDirectorIds(env: Env): Promise<string[]> {
  const raw = await env.KV.get("config:director_ids");
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
}

export function isDirector(directorIds: readonly string[], userId: string | undefined): boolean {
  return !!userId && directorIds.includes(userId);
}
