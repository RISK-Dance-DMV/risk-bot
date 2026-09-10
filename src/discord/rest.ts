import type { Env } from "../env";
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

interface GuildChannel {
  id: string;
  name: string;
}

/**
 * Channel names live in config; IDs never do (design doc s2). Resolved lazily and
 * cached in KV, with `fresh` forcing a re-resolve after a 404.
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

  const channels = (await res.json()) as GuildChannel[];
  const match = channels.find((c) => c.name === name);
  if (!match) throw new Error(`no channel named #${name} in guild ${guildId}`);

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
 * Fail loudly (design doc s6.2). Never throws - an alert that throws hides the
 * original failure.
 */
export async function alertDirectors(env: Env, content: string): Promise<void> {
  try {
    await postToChannelByName(
      env,
      env.GUILD_DANCE_ID,
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
