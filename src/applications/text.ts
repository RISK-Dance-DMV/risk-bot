/** Shared text helpers for card rendering. Pure. */

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function escapeMd(text: string): string {
  return text.replace(/([*_`~|\\])/g, "\\$1");
}

/** Renders as a name, and pings nobody when allowed_mentions is empty. */
export function mention(discordId: string): string {
  return `<@${discordId}>`;
}
