/** Interaction helpers: response builders, and readers for inbound payloads. */
import {
  InteractionResponseType,
  MessageFlags,
  type Interaction,
  type MessagePayload,
} from "./types";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function ephemeral(content: string): { type: number; data: MessagePayload } {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: MessageFlags.EPHEMERAL },
  };
}

export const deferredUpdate = { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };

/** Reads one text input out of a modal submission. */
export function modalValue(interaction: Interaction, inputId: string): string {
  for (const row of interaction.data?.components ?? []) {
    for (const component of row.components ?? []) {
      if (component.custom_id === inputId) return component.value ?? "";
    }
  }
  return "";
}
