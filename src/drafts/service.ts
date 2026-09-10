/**
 * Draft lifecycle (design doc rank 6).
 */
import { audit } from "../audit";
import { getNumber } from "../config/settings";
import { deliverEmail } from "../email/service";
import { dispatchPublished } from "./hooks";
import { editMessage, postToChannelByName } from "../discord/rest";
import type { Env } from "../env";
import {
  describeTarget,
  isDueForReping,
  renderDraft,
  renderResolvedDraft,
  validateContent,
  type ChannelRef,
  type Draft,
  type DraftTarget,
  type GuildRef,
} from "./draft";

const DRAFT_TTL = 180 * 24 * 60 * 60;
export const DRAFT_PREFIX = "draft:";

const draftKey = (id: string) => `${DRAFT_PREFIX}${id}`;

export function guildIdFor(env: Env, ref: GuildRef): string {
  return ref === "dance" ? env.GUILD_DANCE_ID : env.GUILD_COMMUNITY_ID;
}

function newDraftId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getDraft(env: Env, id: string): Promise<Draft | null> {
  return env.KV.get<Draft>(draftKey(id), "json");
}

async function putDraft(env: Env, draft: Draft): Promise<void> {
  await env.KV.put(draftKey(draft.id), JSON.stringify(draft), {
    expirationTtl: DRAFT_TTL,
  });
}

export type ActionResult = { ok: true; draft: Draft } | { ok: false; reason: string };

export interface CreateDraftInput {
  kind: string;
  content: string;
  target: DraftTarget;
  confirmation: ChannelRef;
  referencesAt?: string;
  meta?: Record<string, string>;
}

export async function createDraft(
  env: Env,
  input: CreateDraftInput,
): Promise<ActionResult> {
  const invalid = validateContent(input.content);
  if (invalid) return { ok: false, reason: invalid };

  const draft: Draft = {
    id: newDraftId(),
    kind: input.kind,
    state: "pending",
    content: input.content.trim(),
    target: input.target,
    confirmation: input.confirmation,
    createdAt: new Date().toISOString(),
    ...(input.referencesAt ? { referencesAt: input.referencesAt } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  };

  const posted = await postToChannelByName(
    env,
    guildIdFor(env, draft.confirmation.guild),
    draft.confirmation.channel,
    renderDraft(draft),
  );

  const stored: Draft = {
    ...draft,
    messageId: posted.id,
    channelId: posted.channelId,
  };
  await putDraft(env, stored);
  await audit(env, {
    action: "draft.created",
    target: stored.id,
    detail: `${stored.kind} → ${describeTarget(stored.target)}`,
  });
  return { ok: true, draft: stored };
}

/**
 * Takes the draft out of `pending` before doing anything irreversible, so a
 * second click on the same draft is declined rather than publishing twice.
 *
 * KV is eventually consistent, so this narrows the window rather than closing
 * it - two clicks in the same instant can still both win.
 */
async function claim(env: Env, id: string): Promise<ActionResult> {
  const draft = await getDraft(env, id);
  if (!draft) return { ok: false, reason: "That draft is no longer on file." };

  if (draft.state !== "pending") {
    const who = draft.actedBy ? ` by <@${draft.actedBy}>` : "";
    const what = draft.state === "skipped" ? "skipped" : "published";
    return { ok: false, reason: `Already ${what}${who}.` };
  }

  await putDraft(env, { ...draft, state: "publishing" });
  return { ok: true, draft };
}

/** Repaints the draft message with its outcome and drops the buttons. */
async function settle(env: Env, draft: Draft): Promise<void> {
  await putDraft(env, draft);
  if (!draft.channelId || !draft.messageId) return;
  const targetGuildId =
    draft.target.kind === "channel" ? guildIdFor(env, draft.target.guild) : undefined;
  await editMessage(
    env,
    draft.channelId,
    draft.messageId,
    renderResolvedDraft(draft, targetGuildId),
  );
}

type Delivery =
  | { ok: true; messageId?: string; channelId?: string }
  | { ok: false; reason: string };

/** The one place a draft turns into something a person receives. */
async function deliver(env: Env, draft: Draft, content: string): Promise<Delivery> {
  if (draft.target.kind === "email") {
    const sent = await deliverEmail(env, {
      to: draft.target.to,
      subject: draft.target.subject,
      body: content,
    });
    return sent.ok ? { ok: true } : { ok: false, reason: sent.reason };
  }

  try {
    const posted = await postToChannelByName(
      env,
      guildIdFor(env, draft.target.guild),
      draft.target.channel,
      { content, allowed_mentions: { parse: [] } },
    );
    return { ok: true, messageId: posted.id, channelId: posted.channelId };
  } catch (err) {
    return {
      ok: false,
      reason: `Couldn't publish to #${draft.target.channel}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function publish(
  env: Env,
  draft: Draft,
  actor: string,
  content: string,
  publishedAs: "verbatim" | "edited",
): Promise<ActionResult> {
  const delivered = await deliver(env, draft, content);
  if (!delivered.ok) {
    // Hand it back so the draft can be actioned again rather than being stranded.
    await putDraft(env, { ...draft, state: "pending" });
    return { ok: false, reason: delivered.reason };
  }

  const settled: Draft = {
    ...draft,
    content,
    state: "published",
    publishedAs,
    ...(delivered.messageId ? { publishedMessageId: delivered.messageId } : {}),
    ...(delivered.channelId ? { publishedChannelId: delivered.channelId } : {}),
    actedBy: actor,
    actedAt: new Date().toISOString(),
  };
  await settle(env, settled);
  await dispatchPublished(env, settled);
  await audit(env, {
    action: publishedAs === "edited" ? "draft.edited" : "draft.approved",
    actor,
    target: draft.id,
    detail: `${draft.kind} → ${describeTarget(draft.target)}`,
  });
  return { ok: true, draft: settled };
}

/** [Approve] — publish verbatim. */
export async function approveDraft(
  env: Env,
  id: string,
  actor: string,
): Promise<ActionResult> {
  const claimed = await claim(env, id);
  if (!claimed.ok) return claimed;
  return publish(env, claimed.draft, actor, claimed.draft.content, "verbatim");
}

/** [Edit] — publish the edited text. */
export async function editAndPublishDraft(
  env: Env,
  id: string,
  actor: string,
  content: string,
): Promise<ActionResult> {
  const invalid = validateContent(content);
  if (invalid) return { ok: false, reason: invalid };

  const claimed = await claim(env, id);
  if (!claimed.ok) return claimed;
  return publish(env, claimed.draft, actor, content.trim(), "edited");
}

/** [Skip] — log, publish nothing. */
export async function skipDraft(
  env: Env,
  id: string,
  actor: string,
): Promise<ActionResult> {
  const claimed = await claim(env, id);
  if (!claimed.ok) return claimed;

  const settled: Draft = {
    ...claimed.draft,
    state: "skipped",
    actedBy: actor,
    actedAt: new Date().toISOString(),
  };
  await settle(env, settled);
  await audit(env, {
    action: "draft.skipped",
    actor,
    target: settled.id,
    detail: settled.kind,
  });
  return { ok: true, draft: settled };
}


export interface SweepResult {
  pending: number;
  repinged: number;
}

/**
 * "A draft unactioned 48h before the date it references re-pings."
 *
 * Once only - a draft that is going to be ignored shouldn't nag daily.
 */
export async function sweepDrafts(env: Env): Promise<SweepResult> {
  const hours = await getNumber(env, "draft_reping_hours");
  const now = new Date();

  let cursor: string | undefined;
  let pending = 0;
  let repinged = 0;

  do {
    const page = await env.KV.list({ prefix: DRAFT_PREFIX, cursor });
    for (const key of page.keys) {
      const draft = await env.KV.get<Draft>(key.name, "json");
      if (!draft || draft.state !== "pending") continue;
      pending++;
      if (!isDueForReping(draft, now, hours)) continue;

      try {
        const link =
          draft.channelId && draft.messageId
            ? `\nhttps://discord.com/channels/${guildIdFor(env, draft.confirmation.guild)}/${draft.channelId}/${draft.messageId}`
            : "";
        await postToChannelByName(
          env,
          guildIdFor(env, draft.confirmation.guild),
          draft.confirmation.channel,
          {
            content: `⏰ **Still unactioned** — *${draft.kind}*, and the date it references is now inside ${hours}h.${link}`,
            allowed_mentions: { parse: [] },
          },
        );
        await putDraft(env, { ...draft, repingedAt: now.toISOString() });
        await audit(env, { action: "draft.repinged", target: draft.id, detail: draft.kind });
        repinged++;
      } catch (err) {
        console.error("draft reping failed", draft.id, err);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { pending, repinged };
}
