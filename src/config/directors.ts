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

/**
 * Coaches are checked by **role**, not by an enumerated list.
 *
 * The directors are a list because "once all directors have submitted" needs a
 * denominator, and enumerating a role's members over REST would need the
 * GUILD_MEMBERS intent that §2 rules out. Coaches never need a denominator —
 * the only question ever asked is "did a coach click this" — and the answer
 * arrives in the interaction itself, in member.roles. No intent, no list to
 * keep in step with the server.
 *
 *   wrangler kv:key put --binding=KV config:role.coach "123..." --preview false
 */
export async function getCoachRoleId(env: Env): Promise<string | null> {
  const raw = await env.KV.get("config:role.coach");
  const id = (raw ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

/** Directors count as coaches. There is nobody a director can't overrule. */
export function isCoach(
  memberRoles: readonly string[] | undefined,
  coachRoleId: string | null,
  directorIds: readonly string[],
  userId: string | undefined,
): boolean {
  if (isDirector(directorIds, userId)) return true;
  return !!coachRoleId && !!memberRoles?.includes(coachRoleId);
}

/**
 * The Discord role for a subunit, used when a passed trainee is placed.
 *
 *   wrangler kv:key put --binding=KV config:role.hearts "123..." --preview false
 */
export async function getSubunitRoleId(env: Env, subunit: string): Promise<string | null> {
  const raw = await env.KV.get(`config:role.${subunit.toLowerCase()}`);
  const id = (raw ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}
