/**
 * Matching channels by name (design doc s2: "Store channel names in config, never
 * IDs"). Pure.
 *
 * People decorate Discord channels — `📋-directors-bot-confirmation`,
 * `🎭┃audition-review` — and change the decoration later. An exact match would
 * break on that, and because alertDirectors deliberately swallows resolution
 * errors (an alert that throws hides the failure it was reporting), the break
 * would be quiet. So leading and trailing decoration is ignored.
 */

export interface ChannelLike {
  id: string;
  name: string;
}

export type ChannelMatch =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: string };

/** Strips leading/trailing emoji, separators and punctuation. */
export function normalizeChannelName(name: string): string {
  return name
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .toLowerCase();
}

export function matchChannel(
  channels: readonly ChannelLike[],
  wanted: string,
): ChannelMatch {
  // An exact hit wins outright, including over a decorated near-match.
  const exact = channels.find((c) => c.name === wanted);
  if (exact) return { ok: true, id: exact.id, name: exact.name };

  const target = normalizeChannelName(wanted);
  if (!target) return { ok: false, reason: `"${wanted}" isn't a usable channel name` };

  const near = channels.filter((c) => normalizeChannelName(c.name) === target);
  if (near.length === 1 && near[0]) {
    return { ok: true, id: near[0].id, name: near[0].name };
  }
  if (near.length > 1) {
    return {
      ok: false,
      reason: `#${wanted} is ambiguous — ${near
        .map((c) => `#${c.name}`)
        .join(", ")} all match. Put the exact name in config.`,
    };
  }
  return { ok: false, reason: `no channel matching #${wanted}` };
}
