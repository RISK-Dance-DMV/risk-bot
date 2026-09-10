/**
 * Slash command definitions (design doc s2).
 *
 * Layer 1 of three: default_member_permissions "0" hides the command from
 * everyone. Layer 2 is director/coach overrides added by hand in Server Settings
 * -> Integrations. Layer 3 is the role check in the handler, which is the real
 * one - see commands/gate.ts.
 */

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

/** Commands registered in the dance guild, where the director role lives. */
export const DANCE_GUILD_COMMANDS = [FORM_COMMAND];
