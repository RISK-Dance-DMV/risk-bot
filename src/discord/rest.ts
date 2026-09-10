import type { Env } from "../env";
import { matchChannel, type ChannelLike } from "./channelName";
import type { MessagePayload } from "./types";

const API = "https://discord.com/api/v10";
const CHANNEL_CACHE_TTL = 6 * 60 * 60; // seconds

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Discord ${status}: ${body}`);
  }
}

async function discordFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const doFetch = () =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  let res = await doFetch();
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
    await new Promise((r) => setTimeout(r, Math.min(retryAfter, 5) * 1000));
    res = await doFetch();
  }
  return res;
}

/**
 * Channel names live in config; IDs never do (design doc s2). Resolved lazily and
 * cached in KV, with `fresh` forcing a re-resolve after a 404.
 *
 * Matching ignores leading and trailing emoji and separators, so decorating a
 * channel in Discord doesn't quietly break delivery - see channelName.ts.
 */
export async function resolveChannelId(
  env: Env,
  guildId: string,
  name: string,
  fresh = false,
): Promise<string> {
  const cacheKey = `chan:${guildId}:${name}`;
  if (!fresh) {
    const hit = await env.KV.get(cacheKey);
    if (hit) return hit;
  }

  const res = await discordFetch(env, `/guilds/${guildId}/channels`);
  if (!res.ok) throw new DiscordError(res.status, await res.text());

  const match = matchChannel((await res.json()) as ChannelLike[], name);
  if (!match.ok) throw new Error(`${match.reason} in guild ${guildId}`);

  await env.KV.put(cacheKey, match.id, { expirationTtl: CHANNEL_CACHE_TTL });
  return match.id;
}

export async function postMessage(
  env: Env,
  channelId: string,
  payload: MessagePayload,
): Promise<{ id: string }> {
  const res = await discordFetch(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new DiscordError(res.status, await res.text());
  return (await res.json()) as { id: string };
}

/** Post by channel name, re-resolving once if the cached ID has gone stale. */
export async function postToChannelByName(
  env: Env,
  guildId: string,
  name: string,
  payload: MessagePayload,
): Promise<{ id: string; channelId: string }> {
  let channelId = await resolveChannelId(env, guildId, name);
  try {
    const msg = await postMessage(env, channelId, payload);
    return { ...msg, channelId };
  } catch (err) {
    if (!(err instanceof DiscordError) || err.status !== 404) throw err;
    await env.KV.delete(`chan:${guildId}:${name}`);
    channelId = await resolveChannelId(env, guildId, name, true);
    const msg = await postMessage(env, channelId, payload);
    return { ...msg, channelId };
  }
}

export async function editMessage(
  env: Env,
  channelId: string,
  messageId: string,
  payload: MessagePayload,
): Promise<void> {
  const res = await discordFetch(env, `/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new DiscordError(res.status, await res.text());
}

/**
 * Creates a fresh invite for one named person.
 *
 * Single-use and time-limited on purpose. The acceptance email says "7 days or
 * you forfeit your spot", and this is what makes that true rather than a polite
 * request: miss the window and the link is dead, and it can't be forwarded to
 * someone else in the meantime.
 *
 * A fixed link in config can do neither, which is why minting is the default.
 *
 * Needs CREATE_INSTANT_INVITE on the target channel.
 */
export async function createInvite(
  env: Env,
  channelId: string,
  maxAgeSeconds: number,
): Promise<string> {
  const res = await discordFetch(env, `/channels/${channelId}/invites`, {
    method: "POST",
    body: JSON.stringify({
      max_age: Math.floor(maxAgeSeconds),
      max_uses: 1,
      unique: true,
      temporary: false,
    }),
  });
  if (!res.ok) throw new DiscordError(res.status, await res.text());

  const invite = (await res.json()) as { code: string };
  return `https://discord.gg/${invite.code}`;
}

/**
 * Fail loudly (design doc s6.2). Never throws - an alert that throws hides the
 * original failure.
 */
export async function alertDirectors(env: Env, content: string): Promise<void> {
  try {
    await postToChannelByName(
      env,
      env.GUILD_COMMUNITY_ID,
      env.CH_DIRECTORS_CONFIRMATION,
      { content, allowed_mentions: { parse: [] } },
    );
  } catch (err) {
    console.error("alertDirectors failed", err, "original:", content);
  }
}

/**
 * Replace a deferred interaction response. Uses the webhook route, which is valid
 * for the full 15-minute token lifetime.
 */
export async function editOriginalResponse(
  env: Env,
  applicationId: string,
  token: string,
  payload: MessagePayload,
): Promise<void> {
  const res = await fetch(
    `${API}/webhooks/${applicationId}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw new DiscordError(res.status, await res.text());
}
