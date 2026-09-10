/**
 * Slash command definitions (design doc s2).
 *
 * Layer 1 of three: default_member_permissions "0" hides the command from
 * everyone. Layer 2 is director/coach overrides added by hand in Server Settings
 * -> Integrations. Layer 3 is the role check in the handler, which is the real
 * one - see commands/gate.ts.
 */

/**
 * Design doc §2's permission list, plus VIEW_CHANNEL (needed to read anything)
 * and CREATE_INSTANT_INVITE (acceptance emails carry a fresh, expiring invite).
 */
export const INVITE_PERMISSIONS = "562984581672019";

export const ApplicationCommandOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
} as const;

export const FORM_COMMAND = {
  name: "form",
  description: "Register the application or audition form",
  default_member_permissions: "0",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "register",
      description: "Point the bot at a newly created form",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "type",
          description: "Which form this is",
          required: true,
          // The application sheet is addressed by URL in Apps Script rather than
          // registered, because that form doesn't rotate. Audition forms do.
          choices: [{ name: "audition", value: "audition" }],
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "url",
          description: "The form's URL — it must have been created by the RISK account",
          required: true,
        },
      ],
    },
  ],
} as const;

export const WAITLIST_COMMAND = {
  name: "waitlist",
  description: "Bring waitlisted applicants back round",
  default_member_permissions: "0",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "open",
      description: "A spot opened — show who's waiting for it",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "subunit",
          description: "Which subunit has room",
          required: true,
          choices: [
            { name: "Spades", value: "Spades" },
            { name: "Hearts", value: "Hearts" },
            { name: "Clubs", value: "Clubs" },
          ],
        },
      ],
    },
  ],
} as const;

/**
 * Registered in the community guild. Everything built so far — applications,
 * decisions, interviews, drafts, email — lives there; the dance guild comes in
 * with the trainee and money ranks.
 */
export const COMMUNITY_GUILD_COMMANDS = [FORM_COMMAND, WAITLIST_COMMAND];
