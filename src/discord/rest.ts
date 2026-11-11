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
 * Opens a thread on a message, so everything said about one applicant stays
 * attached to their card instead of scattering through the channel.
 *
 * Seven days is Discord's maximum auto-archive, and posting in a thread
 * unarchives it - so an active discussion never disappears mid-conversation.
 *
 * Needs CREATE_PUBLIC_THREADS, and SEND_MESSAGES_IN_THREADS to say anything in
 * one afterwards.
 */
export async function createThreadOnMessage(
  env: Env,
  channelId: string,
  messageId: string,
  name: string,
): Promise<string> {
  const res = await discordFetch(
    env,
    `/channels/${channelId}/messages/${messageId}/threads`,
    {
      method: "POST",
      body: JSON.stringify({
        name: name.slice(0, 100),
        auto_archive_duration: 10080,
      }),
    },
  );
  if (!res.ok) throw new DiscordError(res.status, await res.text());

  const thread = (await res.json()) as { id: string };
  return thread.id;
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

/**
 * A new ephemeral message on an interaction that has already been answered.
 *
 * Not editOriginalResponse: after a DEFERRED_UPDATE_MESSAGE, `@original` is the
 * message the component lives on — the card — so patching it would overwrite
 * the card with the note.
 */
export async function followUp(
  env: Env,
  applicationId: string,
  token: string,
  payload: MessagePayload,
): Promise<void> {
  const res = await fetch(`${API}/webhooks/${applicationId}/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new DiscordError(res.status, await res.text());
}

/**
 * DMs a member, best-effort.
 *
 * Returns false rather than throwing when the DM can't be delivered — members
 * routinely have DMs from server members turned off, and that is not a failure
 * of the thing that wanted to tell them something. Callers fall back to saying
 * it somewhere the person can actually see.
 */
export async function sendDirectMessage(
  env: Env,
  userId: string,
  payload: MessagePayload,
): Promise<boolean> {
  try {
    const res = await discordFetch(env, "/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: userId }),
    });
    const channel = (await res.json()) as { id?: string };
    if (!channel.id) return false;
    await postMessage(env, channel.id, payload);
    return true;
  } catch (err) {
    console.error("DM failed", userId, err);
    return false;
  }
}

/**
 * Adds a role to a guild member. The bot's own role must sit above the role it
 * is granting, which is a server setting, not something a token can fix — so a
 * 403 here means the role hierarchy, not the permission bit.
 */
export async function addRole(
  env: Env,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await discordFetch(env, `/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
  });
}

/** The counterpart to addRole, and subject to the same role-hierarchy rule. */
export async function removeRole(
  env: Env,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await discordFetch(env, `/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "DELETE",
  });
}

/**
 * Archives a thread — Discord's "closed". Not destructive: the thread stays
 * readable, drops out of the active list, and posting to it reopens it.
 */
export async function archiveThread(env: Env, threadId: string): Promise<void> {
  await discordFetch(env, `/channels/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}

/** A member's current role ids, or null when they can't be read. */
export async function memberRoles(
  env: Env,
  guildId: string,
  userId: string,
): Promise<string[] | null> {
  try {
    const res = await discordFetch(env, `/guilds/${guildId}/members/${userId}`);
    if (!res.ok) return null;
    const member = (await res.json()) as { roles?: string[] };
    return member.roles ?? [];
  } catch {
    return null;
  }
}

export interface FetchedPoll {
  question?: { text?: string };
  answers?: { answer_id: number; poll_media?: { text?: string } }[];
  expiry?: string;
  results?: {
    is_finalized?: boolean;
    answer_counts?: { id: number; count: number }[];
  };
}

/** One message, for reading a poll's results off it. */
export async function getMessage(
  env: Env,
  channelId: string,
  messageId: string,
): Promise<{ id: string; poll?: FetchedPoll }> {
  const res = await discordFetch(env, `/channels/${channelId}/messages/${messageId}`);
  if (!res.ok) throw new DiscordError(res.status, await res.text());
  return (await res.json()) as { id: string; poll?: FetchedPoll };
}

/**
 * Who voted for one answer.
 *
 * A native poll's counts are just numbers; a session needs the list of people,
 * both to pre-fill attendance and because §8 wants the signal filtered to
 * trainees rather than everyone who saw the message.
 */
export async function pollAnswerVoters(
  env: Env,
  channelId: string,
  messageId: string,
  answerId: number,
): Promise<{ id: string; username?: string; global_name?: string }[]> {
  const res = await discordFetch(
    env,
    `/channels/${channelId}/polls/${messageId}/answers/${answerId}?limit=100`,
  );
  if (!res.ok) throw new DiscordError(res.status, await res.text());
  const body = (await res.json()) as {
    users?: { id: string; username?: string; global_name?: string }[];
  };
  return body.users ?? [];
}

/**
 * Ends a poll early.
 *
 * Discord finalises results on expiry; without this an "I've seen enough"
 * would have to wait out the full week to read them.
 */
export async function expirePoll(
  env: Env,
  channelId: string,
  messageId: string,
): Promise<void> {
  const res = await discordFetch(env, `/channels/${channelId}/polls/${messageId}/expire`, {
    method: "POST",
  });
  if (!res.ok) throw new DiscordError(res.status, await res.text());
}
