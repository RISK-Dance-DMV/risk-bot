/**
 * Slash command option parsing. Pure.
 */
import type { Interaction, InteractionOption } from "../discord/types";
import { ApplicationCommandOptionType } from "./definitions";

export function optionValues(options: InteractionOption[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const opt of options) {
    if (opt.value !== undefined) out.set(opt.name, String(opt.value));
  }
  return out;
}

/** Resolves `/form register ...` to its subcommand name and options. */
export function subcommandOf(
  interaction: Interaction,
): { name: string; options: Map<string, string> } | null {
  const sub = interaction.data?.options?.[0];
  if (!sub || sub.type !== ApplicationCommandOptionType.SUB_COMMAND) return null;
  return { name: sub.name, options: optionValues(sub.options) };
}
