export interface Env {
  KV: KVNamespace;

  // vars
  GUILD_COMMUNITY_NAME: string;
  CH_AUDITION_REVIEW: string;
  CH_DIRECTORS_CONFIRMATION: string;
  /**
   * Rank 12 lives entirely in the dance guild. The doc puts audition cards in
   * #audition-review, but that is the community server's applications channel —
   * the coaches who answer a proposal work in the dance server, so the card
   * goes where they already are.
   */
  CH_TRAINEE_BOT: string;
  CH_COACHES_CONFIRMATION: string;
  /**
   * Dance guild. Where the Diamonds audition runs — every reply in it is
   * ephemeral, because in a reveal-on-start round the piece must not land
   * anywhere a second person can read it.
   */
  CH_DIAMONDS_BOT: string;
  /** Dance guild. Where the availability poll goes, so trainees see it. */
  CH_ANNOUNCEMENTS: string;
  /** Channels new members are invited into, one per guild. */
  CH_COMMUNITY_INVITE: string;
  CH_DANCE_INVITE: string;
  /**
   * Fixed invite links, used instead of minting. Only needed for a guild the bot
   * isn't in yet - it can't create an invite to a server it hasn't joined.
   */
  COMMUNITY_INVITE_URL?: string;
  DANCE_INVITE_URL?: string;

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
