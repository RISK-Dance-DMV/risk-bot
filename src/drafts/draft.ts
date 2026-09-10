/**
 * Draft -> approve -> publish (design doc rank 6). Pure.
 *
 *   [Approve] -> publish verbatim
 *   [Edit]    -> modal prefilled with the draft -> publish edited
 *   [Skip]    -> log, publish nothing
 *
 * "Every message intended for humans goes through this." It is the safety
 * property the rest of the design rests on, so it has no feature flag - a draft
 * that can't be created would mean the feature above it fails silently.
 */
import { ButtonStyle, ComponentType, type MessagePayload } from "../discord/types";
import { escapeMd, mention, truncate } from "../applications/text";

/** Discord caps message content here, so a draft can never exceed it. */
export const CONTENT_LIMIT = 2000;

export type GuildRef = "dance" | "community";

export interface ChannelRef {
  guild: GuildRef;
  channel: string;
}

/**
 * Where an approved draft goes.
 *
 * An email target routes through the same draft-and-click gate as a channel
 * post - that is the whole point of rank 27's "every send is gated by a click".
 */
export type DraftTarget =
  | { kind: "channel"; guild: GuildRef; channel: string }
  | { kind: "email"; to: string; subject: string };

export function describeTarget(target: DraftTarget): string {
  return target.kind === "channel" ? `#${target.channel}` : target.to;
}

export type DraftState = "pending" | "publishing" | "published" | "skipped";

export interface Draft {
  id: string;
  /** Caller's label, e.g. "interview-invitation". Shown on the draft. */
  kind: string;
  state: DraftState;
  content: string;
  /** Where an approved draft is published. */
  target: DraftTarget;
  /** Where the draft itself is posted for a human to action. */
  confirmation: ChannelRef;
  messageId?: string;
  channelId?: string;
  createdAt: string;
  /**
   * The date this message is about. A draft still unactioned 48h before it
   * re-pings.
   */
  referencesAt?: string;
  repingedAt?: string;
  actedBy?: string;
  actedAt?: string;
  publishedAs?: "verbatim" | "edited";
  publishedMessageId?: string;
  publishedChannelId?: string;
  meta?: Record<string, string>;
}

// ------------------------------------------------------------- custom ids

export type DraftAction = "approve" | "edit" | "skip" | "edit-save";

const ACTIONS: DraftAction[] = ["approve", "edit", "skip", "edit-save"];
const PREFIX = "draft";

/** Persistent - the interaction token expires in ~15 min, the draft does not. */
export function draftCustomId(action: DraftAction, id: string): string {
  return `${PREFIX}|${action}|${id}`;
}

export function parseDraftCustomId(
  raw: string,
): { action: DraftAction; id: string } | null {
  const parts = raw.split("|");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const action = parts[1] as DraftAction;
  if (!ACTIONS.includes(action)) return null;
  const id = parts[2] ?? "";
  if (!/^[a-z0-9]{6,32}$/.test(id)) return null;
  return { action, id };
}

export const EDIT_INPUT_ID = "content";

// -------------------------------------------------------------- rendering

function discordDate(iso: string): string {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(unix) ? `<t:${unix}:D> (<t:${unix}:R>)` : iso;
}

/** Blockquoted so the draft reads as a quotation, not as the bot talking. */
function quote(content: string): string {
  return content
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function renderDraft(draft: Draft): MessagePayload {
  const header = [`📝 **Draft — ${escapeMd(draft.kind)}**`];
  if (draft.target.kind === "channel") {
    header.push(`Publishes to #${draft.target.channel}`);
  } else {
    header.push(`✉️ Sends to \`${draft.target.to}\``);
    header.push(`Subject: ${escapeMd(draft.target.subject)}`);
  }
  if (draft.referencesAt) header.push(`References ${discordDate(draft.referencesAt)}`);

  return {
    content: truncate([...header, "", quote(draft.content)].join("\n"), 4000),
    allowed_mentions: { parse: [] },
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SUCCESS,
            label: "Approve",
            custom_id: draftCustomId("approve", draft.id),
          },
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.PRIMARY,
            label: "Edit",
            custom_id: draftCustomId("edit", draft.id),
          },
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.SECONDARY,
            label: "Skip",
            custom_id: draftCustomId("skip", draft.id),
          },
        ],
      },
    ],
  };
}

/** The draft message after it has been actioned: no buttons, outcome on record. */
export function renderResolvedDraft(draft: Draft, targetGuildId?: string): MessagePayload {
  const who = draft.actedBy ? ` by ${mention(draft.actedBy)}` : "";
  const how = draft.publishedAs === "edited" ? "with edits" : "verbatim";
  const verb = draft.target.kind === "email" ? "sent" : "published";

  const headline =
    draft.state === "skipped"
      ? `🚫 **${escapeMd(draft.kind)} — skipped${who}.** Nothing was ${verb}.`
      : `✅ **${escapeMd(draft.kind)} — ${verb} ${how}${who}.**`;

  const lines = [headline];
  if (draft.state === "published") {
    if (draft.target.kind === "email") {
      lines.push(`To \`${draft.target.to}\``);
    } else if (targetGuildId && draft.publishedChannelId && draft.publishedMessageId) {
      lines.push(
        `https://discord.com/channels/${targetGuildId}/${draft.publishedChannelId}/${draft.publishedMessageId}`,
      );
    }
  }
  lines.push("", quote(draft.content));

  return {
    content: truncate(lines.join("\n"), 4000),
    allowed_mentions: { parse: [] },
    components: [],
  };
}

export function validateContent(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return "A draft can't be empty.";
  if (trimmed.length > CONTENT_LIMIT) {
    return `Drafts cap at ${CONTENT_LIMIT} characters; that one is ${trimmed.length}.`;
  }
  return null;
}

/** True once the draft is inside its 48h window and still unactioned. */
export function isDueForReping(draft: Draft, now: Date, hours: number): boolean {
  if (draft.state !== "pending" || !draft.referencesAt || draft.repingedAt) return false;
  const references = new Date(draft.referencesAt).getTime();
  if (!Number.isFinite(references)) return false;
  return now.getTime() >= references - hours * 60 * 60 * 1000;
}
