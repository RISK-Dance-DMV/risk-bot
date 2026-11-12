/**
 * Slash command definitions (design doc s2).
 *
 * Layer 1 of three: default_member_permissions "0" hides the command from
 * everyone. Layer 2 is director/coach overrides added by hand in Server Settings
 * -> Integrations. Layer 3 is the role check in the handler, which is the real
 * one - see commands/gate.ts.
 */

/**
 * Design doc §2.s permission list, plus what the build actually needs:
 * VIEW_CHANNEL and EMBED_LINKS to post a card at all, CREATE_INSTANT_INVITE for
 * acceptance emails, and SEND_MESSAGES_IN_THREADS for the per-applicant threads.
 */
export const INVITE_PERMISSIONS = "563259459595347";

export const ApplicationCommandOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  NUMBER: 10,
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
 * Rank 12. Registered in the **dance** guild, and deliberately visible to
 * everyone: three of its four subcommands are what a trainee uses, so hiding it
 * behind default_member_permissions "0" would hide it from the people it's for.
 *
 * The coach-only subcommand is gated in the handler, which §2 calls the real
 * layer anyway — and so is the channel, which must be #trainee-bot.
 */
export const AUDITION_COMMAND = {
  name: "audition",
  description: "Propose and submit your trainee audition",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "propose",
      description: "Put a song forward for a coach to approve",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "subunit",
          description: "Which subunit you're auditioning for",
          required: true,
          choices: [
            { name: "Hearts", value: "Hearts" },
            { name: "Spades", value: "Spades" },
          ],
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "song",
          description: "Song name and artist",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "link",
          description: "Link to the song or the choreography",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "timestamp",
          description: "Which part of it, e.g. 1:12-1:45",
          required: false,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "submit",
      description: "Hand in your audition video",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "link",
          description: "Link to your video — check it's viewable by anyone with the link",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "extend",
      description: "Ask a coach for more time",
      options: [
        {
          type: ApplicationCommandOptionType.INTEGER,
          name: "days",
          description: "How many extra days you need",
          required: true,
          min_value: 1,
          max_value: 30,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "reason",
          description: "Why you need longer",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "reopen",
      description: "Coaches: undo a lapsed audition",
      options: [
        {
          type: ApplicationCommandOptionType.USER,
          name: "trainee",
          description: "Whose audition to reopen",
          required: true,
        },
      ],
    },
  ],
} as const;

/**
 * Rank 7's bootstrap. Hidden from everyone by default_member_permissions — it
 * sets the anchor every later cycle is computed from, so it is not something to
 * leave discoverable in a channel trainees can see.
 */
export const CYCLE_COMMAND = {
  name: "cycle",
  description: "Set up the training cycle",
  default_member_permissions: "0",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "start",
      description: "Record the cycle that's running now — every later one follows from it",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "starts",
          description: "First day, YYYY-MM-DD",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "ends",
          description: "Last day, YYYY-MM-DD",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "focus",
          description: "What this cycle trains",
          required: true,
          choices: [
            { name: "Isolations & Body Control", value: "Isolations & Body Control" },
            { name: "Power & Dynamics", value: "Power & Dynamics" },
            { name: "Lines & Pictures", value: "Lines & Pictures" },
            { name: "Groove", value: "Groove" },
            { name: "Footwork", value: "Footwork" },
          ],
        },
        {
          type: ApplicationCommandOptionType.USER,
          name: "coach",
          description: "Who's coaching it",
          required: false,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "choreo",
          description: "What they're learning",
          required: false,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "booked",
      description: "Show which sessions still need a room, and mark one booked",
      options: [],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "poll-close",
      description: "End the availability poll now and show what it said",
      options: [],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "close",
      description: "Close whichever cycle is open, whether it's running or mid-setup",
      options: [],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "poll",
      description: "Ask the trainees: builds the next cycle's poll for you to tweak",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "starts",
          description: "First day of the cycle, if it starts before the first practice",
          required: false,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "ends",
          description: "Last day of the cycle, if it runs past the last practice",
          required: false,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "schedule",
      description: "Lay the cycle's sessions out across its dates",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "focus",
          description: "Override the cycle's focus for this schedule",
          required: false,
          choices: [
            { name: "Isolations & Body Control", value: "Isolations & Body Control" },
            { name: "Power & Dynamics", value: "Power & Dynamics" },
            { name: "Lines & Pictures", value: "Lines & Pictures" },
            { name: "Groove", value: "Groove" },
            { name: "Footwork", value: "Footwork" },
          ],
        },
      ],
    },
  ],
} as const;

/**
 * Shared by the three director subcommands that act on one round.
 *
 * Defaulted rather than required, because under rolling rounds the round is
 * read off the dancer's own record — a director assigning a piece is almost
 * always assigning the round that person is already waiting in.
 */
const ROUND_OPTION = {
  type: ApplicationCommandOptionType.STRING,
  name: "round",
  description: "Which round (defaults to the one they're in)",
  required: false,
  choices: [
    { name: "Round 0", value: "0" },
    { name: "Round 1", value: "1" },
    { name: "Round 2", value: "2" },
  ],
} as const;

/**
 * The Diamonds comp audition (DIAMONDS.md).
 *
 * No default_member_permissions, same reasoning as /audition: five of these
 * subcommands are for the people auditioning, and hiding the command would
 * hide it from them. The director-only ones are gated in the handler, which is
 * the real layer — along with the channel, which must be #diamonds-bot.
 *
 * Neither `start` nor `submit` takes a round. The round is derived from the
 * dancer's own record: someone who has to know they're in Round 1 to submit is
 * someone the process has already failed.
 */
export const DIAMONDS_COMMAND = {
  name: "diamonds",
  description: "The Diamonds audition — register, start your window, submit",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "register",
      description: "Put your name down for this Diamonds audition",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "plan",
          description: "Roughly when you'll send your Round 0 (YYYY-MM-DD) — an estimate, not a commitment",
          required: false,
        },
        {
          type: ApplicationCommandOptionType.BOOLEAN,
          name: "practice",
          description: "Do all three rounds for feedback only — no pass or fail, nothing recorded",
          required: false,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "start",
      description: "Get your piece and start your window — the clock starts when you press it",
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "submit",
      description: "Submit your video for the round you're in",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "link",
          description: "A link to the video",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "plan",
      description: "Say roughly when you'll start the round you're in, and get reminded",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "date",
          description: "YYYY-MM-DD — change it whenever you like",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "status",
      description: "Where you stand, and what happens next",
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "withdraw",
      description: "Take yourself off the list",
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "config",
      description: "Directors: what this will run on — read before the flag",
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "schedule",
      description: "Directors: set when auditions opened (YYYY-MM-DD)",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "opens",
          description: "First day anyone can register and submit Round 0",
          required: false,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "add",
      description: "Directors: put someone on the list after auditions have closed",
      options: [
        {
          type: ApplicationCommandOptionType.USER,
          name: "dancer",
          description: "Who to add",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "cohort",
          description: "Returning Diamonds skip Round 0's cover",
          required: true,
          choices: [
            { name: "Newcomer — owes a Round 0 cover", value: "new" },
            { name: "Returning Diamond — owes nothing", value: "returning" },
          ],
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "grant",
      description: "Directors: record an existing Diamond's membership, no audition",
      options: [
        {
          type: ApplicationCommandOptionType.USER,
          name: "dancer",
          description: "Who",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "until",
          description: "YYYY-MM-DD they must re-audition by — leave blank to derive it from today",
          required: false,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "assign",
      description: "Directors: put one person's piece up, with what it's testing",
      options: [
        {
          type: ApplicationCommandOptionType.USER,
          name: "dancer",
          description: "Who it's for",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "piece",
          description: "A link to the piece, or the song",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "target",
          description: "Round 1: the one specific thing this tests — \"elbows collapse\", not \"execution\"",
          required: false,
        },
        {
          type: ApplicationCommandOptionType.NUMBER,
          name: "starting-score",
          description: "Round 1: 0-10, where that one thing sits today. Fixed here, for good",
          required: false,
          min_value: 0,
          max_value: 10,
        },
        ROUND_OPTION,
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "assign-all",
      description: "Directors: one piece to everyone who hasn't started — Round 2's",
      options: [
        {
          type: ApplicationCommandOptionType.STRING,
          name: "piece",
          description: "A link to the piece, or the song",
          required: true,
        },
        ROUND_OPTION,
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "extend",
      description: "Directors: add days to someone's window, or to their whole run",
      options: [
        {
          type: ApplicationCommandOptionType.USER,
          name: "dancer",
          description: "Who it's for",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.INTEGER,
          name: "days",
          description: "How many days — size it to what went wrong, not a second window",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "reason",
          description: "What happened (recorded, not sent)",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "scope",
          description: "This round's window, or their whole audition. Defaults to the window",
          required: false,
          choices: [
            { name: "This round's window", value: "window" },
            { name: "Their whole audition — reopens it if it closed", value: "run" },
          ],
        },
        ROUND_OPTION,
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "score",
      description: "Directors: your sealed ballot on whichever round is waiting",
      options: [
        {
          type: ApplicationCommandOptionType.USER,
          name: "dancer",
          description: "Who you're scoring",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.STRING,
          name: "verdict",
          description: "Round 0: does this person belong in the process? No numbers",
          required: false,
          choices: [
            { name: "Pass — through to Round 1", value: "pass" },
            { name: "Fail — not this cycle", value: "fail" },
          ],
        },
        {
          type: ApplicationCommandOptionType.NUMBER,
          name: "target-score",
          description: "Round 1: 0-10 for the one named thing, now",
          required: false,
          min_value: 0,
          max_value: 10,
        },
        {
          type: ApplicationCommandOptionType.NUMBER,
          name: "technicality",
          description: "Round 2: 0-10",
          required: false,
          min_value: 0,
          max_value: 10,
        },
        {
          type: ApplicationCommandOptionType.NUMBER,
          name: "execution",
          description: "Round 2: 0-10",
          required: false,
          min_value: 0,
          max_value: 10,
        },
        {
          type: ApplicationCommandOptionType.NUMBER,
          name: "performance",
          description: "Round 2: 0-10",
          required: false,
          min_value: 0,
          max_value: 10,
        },
        {
          type: ApplicationCommandOptionType.NUMBER,
          name: "musicality",
          description: "Round 2: 0-10",
          required: false,
          min_value: 0,
          max_value: 10,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "result",
      description: "Directors: read a settled result back, then send it",
      options: [
        {
          type: ApplicationCommandOptionType.USER,
          name: "dancer",
          description: "Who it's for",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "feedback",
      description: "Directors: leave feedback — any time, before or after your ballot",
      options: [
        {
          type: ApplicationCommandOptionType.USER,
          name: "dancer",
          description: "Who it's for",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SUB_COMMAND,
      name: "roster",
      description: "Directors: who's where, who's waiting on you, what's still owed",
    },
  ],
} as const;

/** The dance guild: rank 12's auditions, rank 7's cycles, and Diamonds. */
export const DANCE_GUILD_COMMANDS = [AUDITION_COMMAND, CYCLE_COMMAND, DIAMONDS_COMMAND];

/**
 * Registered in the community guild. Everything built so far — applications,
 * decisions, interviews, drafts, email — lives there; the dance guild comes in
 * with the trainee and money ranks.
 */
export const COMMUNITY_GUILD_COMMANDS = [FORM_COMMAND, WAITLIST_COMMAND];
