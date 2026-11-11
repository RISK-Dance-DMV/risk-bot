/**
 * The Diamonds audition timeline, and the announcement that goes with it.
 *
 *   npm run diamonds -- 2026-11-15 2027-01-10            # dates + announcement
 *   npm run diamonds -- 2026-11-15 2027-01-10 --calendar # just the dates
 *   npm run diamonds -- --help                           # every flag
 *
 * **Two dates, not five.** The rounds used to run as cohort-wide phases — one
 * day everybody's Round 1 opened, another it closed — which took five dates to
 * describe and bought nothing: the audition is pass/fail against a fixed bar,
 * so nobody is compared to anybody, and all the phases did was make people wait
 * for each other. What's left is when the thing opens and when it shuts.
 *
 * Everything else is derived from those two plus the policy numbers, which is
 * why there is nothing here to keep in step by hand:
 *
 *   last useful Round 0   closes − (review + window + review + window)
 *   last window start     closes − window
 *
 * Pure date arithmetic in UTC. These are calendar days, not instants; a
 * timezone would be inventing precision a deadline doesn't have. The Worker
 * resolves the same two days into instants in the crew's timezone — see
 * src/diamonds/config.ts, which carries these same defaults.
 */

/**
 * The commands the announcement tells people to use.
 *
 * Self-serve by design: getting your piece and starting your window are things
 * you do yourself, at whatever hour suits you, with no director in the loop.
 * The only coordination left is the two things that genuinely need a human —
 * putting the pieces up, and reviewing what comes back.
 *
 * Overridable with --cmd-prefix= if the command gets named something else.
 */
const DEFAULT_CMD = "diamonds";

const DEFAULTS = {
  /** Days to learn a piece, record it and submit. */
  window: 3,
  /** The slow end of the turnaround we promise after each submission. */
  review: 5,
  /** And the quick end, for the range the announcement quotes. */
  reviewMin: 1,
  /** Default length of the whole thing, if no close date is given. */
  span: 56,
} as const;

export interface Options {
  window: number;
  review: number;
  reviewMin: number;
  cmd: string;
}

export interface Timeline {
  opens: Date;
  closes: Date;
  /** Last day a Round 0 still leaves room for Rounds 1 and 2. */
  lastRound0: Date;
  /** Last day any window may start. */
  lastStart: Date;
  /** Days three rounds take at worst, from a Round 0 submission. */
  needed: number;
  /** The soonest anyone could be finished, if they start on day one. */
  earliestFinish: Date;
  window: number;
  review: number;
  reviewMin: number;
}

const DAY = 24 * 60 * 60 * 1000;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);

export function timeline(opens: Date, closes: Date, o: Options): Timeline {
  // Two reviews and two windows, and nothing else: Round 1 is gated on the
  // feedback arriving rather than on a countdown, so the only waiting the
  // process imposes is the reviewing. Must agree with daysStillNeeded in
  // src/diamonds/audition.ts.
  const needed = o.review + o.window + o.review + o.window;
  return {
    opens,
    closes,
    lastRound0: addDays(closes, -needed),
    lastStart: addDays(closes, -o.window),
    needed,
    earliestFinish: addDays(opens, needed),
    window: o.window,
    review: o.review,
    reviewMin: o.reviewMin,
  };
}

/**
 * Timelines that can't be run, refused rather than printed.
 *
 * One check, where there used to be four: with a single window there is only
 * one way to get this wrong, which is to make it too short for anyone to finish.
 */
export function problems(t: Timeline): string[] {
  const span = (t.closes.getTime() - t.opens.getTime()) / DAY;
  if (span <= 0) return ["Auditions close before they open."];
  if (span < t.needed) {
    return [
      `The timeline is ${Math.round(span)} days and three rounds take ${t.needed}: ` +
        `nobody could finish even by starting on day one.`,
    ];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function short(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function long(date: Date): string {
  return `${short(date)} (${WEEKDAYS[date.getUTCDay()]})`;
}

export function renderCalendar(t: Timeline): string {
  const rows: [string, Date, string][] = [
    ["Auditions open", t.opens, "register and send Round 0 from here"],
    ["Last useful Round 0", t.lastRound0, `closes − ${t.needed}, derived`],
    ["Last day to start a window", t.lastStart, `closes − ${t.window}`],
    ["Auditions close", t.closes, "every window must have shut"],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(
    ([label, date, note]) => `  ${label.padEnd(width)}  ${long(date).padEnd(14)} ${note}`,
  );

  return [
    `Diamonds ${t.closes.getUTCFullYear()} — open ${long(t.opens)} to ${long(t.closes)}`,
    "",
    ...lines,
    "",
    `  Each round: ${t.window} days to learn, record and submit.`,
    `  Reviewed in ${t.reviewMin}-${t.review} days; the feedback is what opens the next round.`,
    `  Three rounds end to end: ${t.needed} days at worst, from a Round 0 submission.`,
  ].join("\n");
}

export function renderAnnouncement(t: Timeline, cmd: string): string {
  return `Hi everyone! **Diamonds auditions for ${t.closes.getUTCFullYear()}** are open from
**${short(t.opens)}** and close **${short(t.closes)}**.

To **qualify** for Diamonds you need to have participated in at least one Major
cover or Diamonds project. **But anyone can audition** — and we mean that. It's a
real chance to practise under pressure and get written feedback from the
directors, and everyone who submits gets that feedback whether or not they
advance.

**There are no round dates.** You move through the three rounds at your own
pace: finish one, we review it, the next one opens for you. Go straight at it and
you could be done by **${short(t.earliestFinish)}**; leave it until the new year
and that works too. Nobody is waiting on anybody else, and nobody is being
compared to anybody else — each round is judged against a standard, not against
the people who happened to audition the same week.

**Register with \`/${cmd} register\` in #diamonds-bot.**

It'll ask roughly when you plan to send your Round 0, and you can say the same
for each round afterwards with \`/${cmd} plan date:YYYY-MM-DD\`. **None of it is
binding.** Change it as often as you like, nothing is held against it, and a date
that slips is genuinely fine.

What it does is get you a reminder on the morning you picked. We're asking
because this is the one part of the process nobody is scheduling for you — there
is no rehearsal in the diary, no phase opening on a Monday, nothing but a close
date eight weeks out. **A day you chose yourself is much easier to hit than no
day at all**, and the people who pick one and stick to it have a far easier time
of this than the people who mean to get round to it. It also lets us spread the
reviewing out instead of discovering everyone at once.

**We review anything you send in ${t.reviewMin}–${t.review} days.** That's the
promise on our side, and your feedback and your next piece arrive together.

**Both directors judge every round independently**, without seeing each other's
until both are in. Where a round is scored, your score is the average of the
two, and if we end up far apart on something we talk about it before anything
reaches you.

**Round 0 — where you are now**
Post a cover that shows your strengths, your own choice of piece. An existing one
from the **last six months is fine** — you don't have to film anything new.
\`/${cmd} submit link:<url>\`, and you can replace it any time before we review it.

**Round 0 is a yes or a no, not a score.** The question is just whether to take
you through, and we'll answer it in the same message as your written feedback —
at least three things you brought, and at most three to work on. Everyone who
submits gets that feedback, including anyone we don't take through.

If you're already in Diamonds, Round 0 asks nothing of you: no video, nothing to
submit. You'll get the same written document on your season, with the same yes
or no, and that document is what opens Round 1 for you.

There's no deadline on Round 0 as such. The date that matters is
**${short(t.lastRound0)}**: send it after that and there isn't room left for
Rounds 1 and 2 before ${short(t.closes)}. You're still welcome to audition for
the feedback alone — just know it can't finish this cycle. Sooner is easier on
everyone, yours included.

**Round 1 — the one thing we named**
Your piece comes with **one specific thing** it's testing. Not "execution" —
something you can actually go and practise, and we'll tell you where we have it
today, so you can see exactly what the round is asking you to move.

**Round 1 can't start until your feedback has reached you** — it's a response to
that feedback, so there's nothing to work on before it arrives. Once it has,
there's no clock on you at all: take a day or take three weeks, work on the thing
we named, and press the button when you're actually ready. The ${t.window} days
only start when you do.

**Round 1 is not scored like
Round 2.** It doesn't go near the bar. It scores that one named thing against
where it started — so someone who began at a 1 and got to a 6 has done something
remarkable, and someone already strong there who held steady is fine too. What
doesn't pass is no movement.

**Round 2 — the standard**
Everyone dances the **same** final piece, chosen to reflect the level we expect
Diamonds to execute at. You each get it **privately**, the moment you start.
${t.window} days, same as Round 1.

This one is the rubric: Technicality, Execution, Performance, and Musicality &
Timing, weighted, against a fixed bar with a floor no single area may sit below.

**Because it's the same piece for all of you, keep it to yourself.** Don't tell
anyone what the song is, don't describe the choreography, and don't even try to
play a game and drop hints.

**Two things worth repeating.** **Starting commits you** — in both rounds one
button reveals your piece and starts your ${t.window} days at the same moment, so
don't press it to peek. And the last day anyone can start a window at all is
**${short(t.lastStart)}**, because every window has to have shut by
${short(t.closes)}.`;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const HELP = `Diamonds audition timeline.

  npm run diamonds -- <opens> [closes] [flags]

Dates are YYYY-MM-DD. With no close date, it runs ${DEFAULTS.span} days.

  --calendar          just the dates, no announcement
  --window=N          days to learn, record and submit  (default ${DEFAULTS.window})
  --review=N          slow end of the review turnaround (default ${DEFAULTS.review})
  --review-min=N      the quick end of that range          (default ${DEFAULTS.reviewMin})
  --span=N            length, when no close date is given (default ${DEFAULTS.span})
  --cmd-prefix=NAME   the slash command's name           (default ${DEFAULT_CMD})
  --help

The same two days live in KV for the Worker — see src/diamonds/config.ts, and
set them with /diamonds schedule. Change both together or neither.`;

function flag(args: string[], name: string): string | undefined {
  const found = args.find((one) => one.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

function number(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`--${name} needs a number of days, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

function parseDay(raw: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.error(`Dates are YYYY-MM-DD, got: ${raw}`);
    process.exit(1);
  }
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    console.error(`Not a real date: ${raw}`);
    process.exit(1);
  }
  return date;
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  const days = args.filter((one) => !one.startsWith("--"));
  if (days.length === 0) {
    console.log(HELP);
    process.exit(1);
  }

  const opens = parseDay(days[0]!);
  const options: Options = {
    window: number(args, "window", DEFAULTS.window),
    review: number(args, "review", DEFAULTS.review),
    reviewMin: number(args, "review-min", DEFAULTS.reviewMin),
    cmd: flag(args, "cmd-prefix") ?? DEFAULT_CMD,
  };
  const closes = days[1]
    ? parseDay(days[1])
    : addDays(opens, number(args, "span", DEFAULTS.span));

  const t = timeline(opens, closes, options);
  const wrong = problems(t);
  if (wrong.length > 0) {
    console.error("That timeline can't be run:\n");
    for (const one of wrong) console.error(`  - ${one}`);
    process.exit(1);
  }

  console.log(`\n${renderCalendar(t)}\n`);
  if (!args.includes("--calendar")) {
    console.log("─".repeat(78));
    console.log("ANNOUNCEMENT — paste as-is\n");
    console.log(renderAnnouncement(t, options.cmd));
  }
}

main(process.argv);
