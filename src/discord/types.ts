export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export const MessageFlags = { EPHEMERAL: 1 << 6 } as const;

export const ComponentType = { ACTION_ROW: 1, BUTTON: 2, TEXT_INPUT: 4 } as const;

export const TextInputStyle = { SHORT: 1, PARAGRAPH: 2 } as const;

/** Modal fields cap at 4000 chars (design doc s6). */
export const MODAL_TEXT_LIMIT = 4000;
export const ButtonStyle = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
} as const;

export interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

export interface Interaction {
  id: string;
  type: number;
  token: string;
  application_id: string;
  data?: {
    custom_id?: string;
    component_type?: number;
    name?: string;
    options?: InteractionOption[];
    /** Modal submissions: action rows wrapping the text inputs. */
    components?: { components?: { custom_id?: string; value?: string }[] }[];
  };
  member?: { user?: { id: string }; roles?: string[] };
  user?: { id: string };
  channel_id?: string;
  guild_id?: string;
}

export interface MessagePayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  flags?: number;
  allowed_mentions?: { parse: string[]; roles?: string[]; users?: string[] };
}
