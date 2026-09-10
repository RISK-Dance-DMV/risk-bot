export interface Env {
  KV: KVNamespace;

  // vars
  GUILD_COMMUNITY_NAME: string;
  CH_AUDITION_REVIEW: string;
  CH_DIRECTORS_CONFIRMATION: string;

  // secrets / ids
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  /** Layer 3 gating: the handler checks this role, never a permission bit. */
  ROLE_DIRECTOR_ID: string;
  GUILD_COMMUNITY_ID: string;
  GUILD_DANCE_ID: string;
  APPS_SCRIPT_URL: string;
  APPS_SCRIPT_SECRET: string;
  INBOUND_SECRET: string;

  /** Optional: base URL of the response sheet, for the "Sheet" link button. */
  APPLICATION_SHEET_URL?: string;
}
