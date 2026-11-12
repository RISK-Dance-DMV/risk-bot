# The Diamonds audition, start to finish

A walkthrough of what actually happens, in order, written to be reviewed
rather than to argue for anything. DIAMONDS.md is the spec and says *why*;
this says *what*, including every message the bot sends on its own.

Everything here is read off the code as it stands today. Where a number
appears it is the shipped default, and all of them live in KV — see
[The numbers](#the-numbers).

- [The short version](#the-short-version)
- [Who does what, and where](#who-does-what-and-where)
- [Before anyone can audition](#before-anyone-can-audition)
- [Registering](#registering)
- [Round 0 — do you belong in the process](#round-0--do-you-belong-in-the-process)
- [Round 1 — did you move the thing we named](#round-1--did-you-move-the-thing-we-named)
- [Round 2 — are you a Diamond](#round-2--are-you-a-diamond)
- [What a pass buys](#what-a-pass-buys)
- [Renewing](#renewing)
- [When it doesn't go cleanly](#when-it-doesnt-go-cleanly)
- [The daily sweep](#the-daily-sweep)
- [Command reference](#command-reference)
- [The numbers](#the-numbers)
- [Things to decide while you read this](#things-to-decide-while-you-read-this)

## The short version

1. A dancer runs `/diamonds register`. Newcomers owe a cover; returning
   Diamonds don't. **`practice:true` makes the whole run feedback-only** —
   same three rounds, same writing, no pass or fail, nothing recorded.
2. **Round 0** — you send a cover of your own choosing (or nothing, if
   you're a returning Diamond). Both directors call pass or fail. The
   verdict travels inside a written feedback document, which is also how
   it reaches you.
3. The verdict reaches you straight away, with a button to read the
   document. **Opening it is what opens Round 1** — not a date, and not our
   sending it.
4. A director assigns you a piece, names **one thing it tests**, and fixes
   a number for where that thing sits today. You press start when you're
   ready, get 3 days, and submit.
5. Both directors score that one thing again. Moving it one anchor step
   (1.25) advances you. Already at or above the bar and not worse also
   advances you.
6. **Round 2** — one piece for everyone, 3-day window, scored on four
   dimensions. Weighted score ≥ 7.5 and nothing below 6 is a pass.
7. A pass makes you a Diamond until the **second Jan 1 or Jul 1 after your
   half of the year closes** — nine to fifteen months. Auditioning early is
   worth months.
8. Renewing means doing all three rounds again, whenever you like. The bot
   warns you at 60, 30 and 20 days. If your date passes with nothing done,
   the role comes off.

The whole thing is **rolling**: which round you're in is a fact about your
record, not about today's date. Nobody waits for anybody — but **all three
rounds have to be done within 60 days of registering**, and that clock is
yours alone.

## Who does what, and where

| | |
| --- | --- |
| **Dancers** | Buttons on the panel in their DMs — start, submit, pick a day, withdraw. `/diamonds register` is the only thing anybody has to type; the rest still work as commands if you prefer. |
| **Directors** | Put pieces up, score, write feedback, send results. Everything else is the bot's. |
| **#diamonds-bot** (dance server) | Where `/diamonds` works. The handler refuses the command anywhere else. |
| **#audition-review** (community server) | Where review cards are posted. One card per person per round. |
| **DMs** | Every result, every reminder, every piece. Nothing a dancer is told is public. |

The review card's buttons work even though `#audition-review` is in a
different server from where `/diamonds` is registered — **component
interactions are cross-guild, slash commands aren't**. That one fact is
what makes the card a console rather than a notification.

## Before anyone can audition

Six things, and the flag is last.

1. `/diamonds schedule opens:` — the open date. **Nothing closes**; each
   person's deadline is their own enforcement date.
2. Set the Diamonds role in KV (`config:role.diamonds`). **Nothing
   revokes a membership while this is unset** — the lapse pass counts what
   it would have done and changes nothing, deliberately.
3. `/diamonds grant` for the members who are grandfathered in.
4. `/diamonds config` — read every number and date back, and check it
   against the announcement you're about to post. A `·` marks a value
   that's still the shipped default rather than something you set.
5. Calibrate both directors against reference videos. Under rolling rounds
   someone can submit on day one and you've promised a review in 1–5 days,
   so this has to happen *before* the announcement, not after.
6. Flip the flag (`config:features.diamonds`). It defaults off, and
   turning it off also stops the daily DMs.

## Registering

`/diamonds register [plan:YYYY-MM-DD]`

`plan` is an estimate of when you'll send Round 0, not a commitment, and
it's what the bot reminds you against. You can change it any time with
`/diamonds plan`.

What the command checks, in order:

1. **The retry wait.** If your last audition didn't pass, you're refused
   until six months after it ended, with the date and a pointer to a
   director. Checked *before* anything else, because archiving the old
   audition is what would hide the thing the wait is counted from.
2. **The close date** — but only for someone who isn't already on the
   list. Somebody already registered is never turned away by the clock;
   they're asking whether they're still in, and they are.
3. **Whether your last audition is finished.** If it is, registering
   again archives it into `history` and starts a fresh one — this is how
   renewal works, and there's no second command for it. If it *isn't*
   finished (you withdrew mid-process), you pick up exactly where you left
   off: the rounds survive and only the withdrawal is cleared.

Your **cohort** decides one thing and one thing only: whether you owe a
Round 0 cover. Newcomers do. Returning Diamonds don't — they're judged on
the season you've just watched.

## Round 0 — do you belong in the process

**The piece is yours.** Nothing is assigned; you pick what to send.

A newcomer submits with `/diamonds submit link:<url>`. An existing cover
from the last six months is fine. A returning Diamond submits nothing and
is ready to be judged the moment they register.

**Both directors call it** — `pass` or `fail`, no numbers. On the review
card that's two buttons. A **split doesn't settle**: there's no majority of
two and no mean of a verdict, so it waits for one of you to move.

**The verdict travels inside the feedback document.** One message, reasons
and decision together. The document needs at least 3 strengths and at most
3 growth areas, and you can write it any time — before the verdicts, which
is usually when you actually want to, and it's held until both land.

Round 0's result **sends itself**: the moment the second verdict arrives,
the held document goes out and that *is* the result. `/diamonds result`
refuses Round 0 and says so.

**Two messages, and the split is deliberate.** The moment the second verdict
lands, a notice goes out carrying **the verdict itself** plus a button. Nobody
has to click to find out whether they're through — that would make opening
your own feedback an act of courage. What the button is for is the reasons.

**Pressing it is what opens Round 1.** A document sitting unopened in a DM has
named nothing to anybody, and Round 1 asks what you did about a named
weakness — so keying the round to our sending it was keying it to our side of
the exchange rather than yours. Re-reading is fine and doesn't move anything;
the first read is the one that counts.

If the notice can't be delivered, nothing is recorded as sent and Round 0 isn't
marked done — fix their DMs and file it again.

**A director can put the Round 1 piece up before you've read it.** That's their
job and it shouldn't wait on your inbox; the piece is only revealed when you
start anyway. What you can't do is start the window — you'll be told it's in
your DMs, which is a different sentence from "it hasn't arrived".

If you leave it unopened, you get **one** nudge, three days on. Then it's
yours.

## Round 1 — did you move the thing we named

This is the only round with a prerequisite: your feedback has to have
reached you.

**A director assigns your piece** — `/diamonds assign dancer: piece:
target: starting-score:`. Three things, one sitting:

- the piece,
- **the one specific thing it tests** — "elbows collapse", not
  "execution",
- and **where that thing sits today**, 0–10.

That number is **fixed at assignment and refuses to be re-fixed**. It's
set while the video it will be compared against doesn't exist yet, which
is the only moment it can be an honest read.

**You press start when you're ready.** The piece is revealed to you then,
not before, and the clock starts: 3 days to learn it, record it, submit it.
The clock doesn't stop. If something goes wrong, say so *before* the
window closes — a director can add days with `/diamonds extend`, sized to
what went wrong rather than as a second window.

**Both directors score that one named thing again**, 0–10. **The worse it
started, the more it has to move** — the ask is half the distance to the bar,
never less than one anchor step (1.25), and never above the bar itself:

| Starts at | Has to reach | | Starts at | Has to reach |
| --- | --- | --- | --- | --- |
| 1 | **4.25** | | 6 | **7.25** |
| 2 | **4.75** | | 7 | **7.5** |
| 3 | **5.25** | | 7.5+ | **hold it** |
| 4 | **5.75** | | 9 | **hold it** |
| 5 | **6.25** | | | |

At or above the bar the ask is that it's still there. Below it, the ask shrinks
as you get better — and nothing ever asks you to beat the bar in a round that
isn't about the bar. The panel quotes your number, so nobody has to work this
out.

Miss it and the round is a **fail** — and that's where the directors get a
choice. They can send the fail, or press **Carry on as practice**, which sends
the same fail *and* takes you into Round 2 with nothing riding on it. The round
still says failed, because it did; practice starting at Round 2 says it wasn't
the end. Both facts are kept, because both are true.

**"Practice" is not "failed"**, but it does end the audition for this
cycle. The distinction is real: the announcement invites people to keep
going after not advancing, so "didn't advance but is still in the room"
had to be its own outcome.

You're told both numbers. A delta you can't see the start of is a verdict
rather than a measurement.

## Round 2 — are you a Diamond

**One piece to everyone** — `/diamonds assign-all piece: round:2`. Still
revealed on start, even though you all dance the same thing, so the window
measures the same task for everybody: three days with the piece whether you
start the first day it's up or the last. Yes, the first person to start
can tell the rest; the announcement asks them not to and stops there.

Same mechanic as Round 1 — start, 3 days, submit.

**Both directors score four dimensions**, 0–10 each:

| Dimension | Weight |
| --- | --- |
| Technicality | 40% |
| Execution | 30% |
| Performance | 20% |
| Musicality | 10% |

**A pass needs both:** weighted score **≥ 7.5**, and **nothing below 6**.

The floor matters *more* under weighting, not less. 10/10/10/0 weights to
9.0 — it would sail past any bar with a zero in musicality. In a
competition unit a dimension at 5 is visible on stage next to three people
who have it.

Ballots are **sealed**: until both are in, the card reports a count and
nothing else. No anchoring.

## Practice

Two ways in, and they're the same fact from different directions.

**You ask for it at registration** (`practice:true`). All three rounds, no
verdict in any of them:

- **Round 0** has nothing to call, so the feedback document *is* the round —
  it goes the moment it's written, with no verdicts to wait for.
- **Rounds 1 and 2** are still scored by both directors, because the numbers
  are what the feedback is built from. They just don't decide anything. A
  Round 1 that didn't move takes you into Round 2 regardless.
- **Round 2 doesn't pass.** No membership, no role, nothing recorded.

**Or a director offers it after a Round 1 fail**, which makes Round 2 practice.

Either way **practice costs nothing** — no six-month wait at the end of it, so
asking for it is never the riskier choice. And it's a choice about *that*
audition: registering again starts a judged run unless you ask for practice
again.

Every panel says so in its heading, and the review card says "Practice —
nothing to decide" rather than looking like a card that needs deciding.

## Your 60 days

One deadline, and it's **yours**: 60 days from the moment you register to
getting all three rounds done. Counted from registration rather than from your
first submission, because the stretch people actually lose is the one between
putting your name down and getting round to Round 0.

The process itself needs about **16 days** — two 3-day windows and two reviews
at the slow end — so there's six weeks of slack for ordinary life and none for
drifting. Every panel shows the date and the days left.

- **Ten days out** you get one warning, with the arithmetic in it.
- **When it runs out** the audition closes: you're DM'd, the directors are told,
  and starting or submitting is refused with the date and a pointer at a
  director.
- **It costs the same six months as dropping out** — decided, and for the same
  reason: there are exactly two ways to not finish, and if one is free it's the
  one everybody takes. Press Withdraw or just stop answering, it's six months
  either way.
- **A practice run costs nothing**, however it ends.
- **`/diamonds extend scope:run`** adds days to it, before or after the date —
  the same command that extends a window, and an extension granted after it ran
  out reopens the audition. `/diamonds add` is the other way back.
- A pass on day 59 is a pass. The clock only touches auditions that haven't
  finished, and it invents nothing for anyone who registered before it existed.

Why have it at all: a Round 1 read taken in November against a Round 2 danced
in April isn't comparing the same dancer.

## What a pass buys

A director sends the result — `/diamonds result dancer:`, or **Read back &
send** on the card. Never a direct send: you read it back first.

Then:

- **The Diamonds role goes on.** If Discord refuses it, the result still
  reaches you and a director is told — a decided result shouldn't be held up
  by a bad minute at Discord's end.
- **Membership is written before the DM goes**, so the message can quote
  the date.
- Your date is the **second Jan 1 or Jul 1 after your half of the year
  closes**:

| You pass in | You're a Diamond until |
| --- | --- |
| Jan – Mar | the next **Jan 1** (12–9 months) |
| Apr – Sep | the next **Jul 1** (15–9 months) |
| Oct – Dec | the Jan 1 **after** next (15–12 months) |

  Enforcement is midnight New York — 05:00 UTC in January, 04:00 in July.
- So a term runs **nine to fifteen months**, and **the earlier in your half
  you audition, the longer you get**. That spread is the incentive, and it
  spreads the directors' review load as a side effect.
- Your date can only ever move **forward**. Re-auditioning can't hand you
  an earlier one, which is why "audition whenever you like" needs no guard.

If the DM fails, **nothing is recorded**. A result marked sent that never
arrived is the worst of both.

## Renewing

Registering again is the door. There is no separate command.

- It's **all three rounds again**. Round 0 for a returning member is the
  application plus current feedback — not a shortcut past the rest.
- The finished audition is **archived into `history`**, and the live one
  starts empty. Everything that reads your rounds goes on reading the live
  audition and never learns there's more than one.
- Your old membership **stays live while you re-audition**. You don't drop
  out of Diamonds to renew.
- The notice markers are **cleared** when a new date is set. A new date
  means a new ladder of warnings.

### The warnings

| Days out | What it says |
| --- | --- |
| **60** | Your date, and that going early is worth more. Nothing to do today. |
| **30** | A month out. A re-audition takes ~16 days end to end, so pick the week. |
| **20** | What happens if nothing does — the role comes off — and to tell a director if something's in the way. |

Only the last rung mentions removal. A removal warning repeated three times
is a removal warning nobody reads.

The **most urgent rung reached** is the one that sends, and it retires every
staler rung with it — so a gentle 60-day notice can never arrive after an
urgent 20-day one.

## When it doesn't go cleanly

**You withdraw.** `/diamonds withdraw` warns you and makes you press a red
button. It takes you off the *audition*, not out of Diamonds — but
**withdrawing counts the same as failing**, so it starts the six-month
wait. Otherwise you could re-roll a piece you didn't like by quitting. The
confirmation names the two things people reach for it by mistake.

**You withdraw from a re-audition and don't come back.** Round reminders
stop; **renewal notices don't**. You are the single person most likely to
reach your date, and silence is what would take you there. On your date
the role comes off.

**Your wait outruns your date.** You get a different notice: the date, the
wait, and *talk to a director* — never "re-audition before then", because
you can't. A director can `add` you to the list inside the wait, and would
rather do that than lose you to a calendar.

**You fail.** Six months from when the audition ended before you can
register again. It's counted from the failure, not from your date — so
fail a renewal in February with a January date and you have five months
spare to go again and keep your membership.

**Your date lands mid-audition.** Nothing happens. The date exists to ask for a
re-audition, and you're answering it — so **no revocation and no reassessment
until that audition ends**, whether it ends a day later or six weeks later. Then
it's decided on the spot: a pass moves your date, and a fail, a withdrawal or
the 60 days running out hands you back to a date that has already gone, which
takes effect immediately. The renewal notices go quiet too, for the same reason.

What stops this being a way to keep the role for ever is the 60-day clock:
registering defers enforcement, and registering also starts a clock that closes
on its own.

**You don't renew at all.** On the morning of your date: the role comes
off, then you're DM'd, then the directors are told. In that order — a
membership that could only end if you were reachable would make closed DMs
a way to stay a Diamond for ever. The DM says it isn't a judgement and
you're welcome back.

**No role is configured.** Nothing is revoked, at all, and the sweep
reports it as blocked. Marking someone revoked while the role stayed on is
the one failure here nobody would ever notice.

**The two who judge it.** Exempt from the whole ladder — and it's a
**Diamond Director** role that says so (`config:role.diamonds_director`), not
the director list, because that list runs rank 7's cycles and rank 12's
auditions too. A director who doesn't judge Diamonds owes their renewal like
anyone else. With the role unset **nobody** is exempt, which is the safe
direction: a notice you can ignore beats a membership that silently stops being
enforced. You're the ones judging, so a date held over you would be the bot
chasing its own judges for a verdict they'd give themselves. You can audition for practice, or drop it,
with no effect on your membership — passing Round 2 doesn't even set you a
date.

**Someone's grandfathered.** `/diamonds grant dancer: [until:]` records a
membership with no audition. Leave `until` blank and it derives the date
from today.

**Someone needs letting in late, or inside the wait.** `/diamonds add`
checks neither. Both refusals exist to route a judgement to the two people
entitled to make it, and that's where they make it.

## The daily sweep

One pass over every record, once a day. **At most one message per person
per day** — the first thing that applies wins, so nobody gets three DMs on
the same morning.

In order:

1. **Window closing** (Rounds 1 and 2) — "closes in X", with a pointer at
   `extend` if something's gone wrong.
2. **Your planned start date** has arrived.
3. **Heads-up** — your piece has been sitting there 10 days.
4. **Registered 10 days ago and still no Round 0 cover.** Counted from your
   registration, because there's no closing door to count back from.
5. **Feedback delivered and never opened**, three days on. Once, and then
   never again — a bot that asks twice is telling someone how to feel about
   their own feedback.
6. **Membership lapsed.** Not a message, a fact, so it sits outside the
   one-a-day rule: someone whose membership ran out this morning should not
   be told about their open window instead.
7. **Renewal notice** — last, and only if nothing else spoke, because
   anyone being reminded to submit is plainly already mid-audition.

Withdrawing silences 1–5 and leaves 6 and 7 running.

The sweep returns counts for all of it, including `blocked` — memberships
that ran out and could not be revoked.

## Command reference

**Dancers** (six, though the buttons cover five of them):

| | |
| --- | --- |
| `/diamonds register [plan:] [practice:]` | Put your name down. Also how you start again. |
| `/diamonds start` | Get your piece; the clock starts. |
| `/diamonds submit link:` | Submit for whichever round you're in. |
| `/diamonds plan date:` | Say roughly when you'll start, and get reminded. |
| `/diamonds status` | Where you stand, your date, and which audition this is if it isn't your first. |
| `/diamonds withdraw` | Warns, then needs a button. Costs six months. |

Neither `start` nor `submit` takes a round. **The round is derived from
your record** — someone who has to know they're in Round 1 to submit is
someone the process has already failed.

**Directors** (eleven):

| | |
| --- | --- |
| `/diamonds config` | Every number and date, and where each came from. Read before the flag. |
| `/diamonds schedule opens:` | The open date. Nothing closes. |
| `/diamonds roster` | Who's where, who's waiting on you, what's owed. |
| `/diamonds assign dancer: piece: target: starting-score: round:` | One person's piece, and Round 1's fixed before-number. |
| `/diamonds assign-all piece: round:` | Round 2's piece, to everyone who hasn't started. |
| `/diamonds score dancer: …` | Your sealed ballot on whichever round is waiting. |
| `/diamonds feedback dancer:` | The Round 0 document. Any time; held until both verdicts. |
| `/diamonds result dancer:` | Read a settled result back, then send it. |
| `/diamonds extend dancer: days: reason: [scope:]` | Add days to an open window, or — with `scope:run` — to their whole 60 days, which reopens a closed audition. |
| `/diamonds add dancer: cohort:` | Late entry, or inside the wait. Checks neither. |
| `/diamonds grant dancer: [until:]` | Record an existing Diamond, no audition. |

Everything scoring-related is also a button on the review card: Pass /
Fail / Write feedback on Round 0, Score / Note on Rounds 1–2, and **Read
back & send** once a round settles.

## The numbers

All in KV, all changeable without a deploy.

| | Default | |
| --- | --- | --- |
| `diamonds_window_days` | 3 | Days to learn, record, submit |
| `diamonds_review_min_days` / `_max_days` | 1 / 5 | The turnaround you're promising |
| `diamonds_min_scores` | 2 | Ballots before a round settles |
| `diamonds_bar` | 7.5 | Round 2's weighted bar; also Round 1's "already there" |
| `diamonds_floor` | 6 | No dimension below this |
| `diamonds_required_steps` | 1 | Anchor steps to advance Round 1 |
| `diamonds_start_nudge_days` | 3 | Days of unopened feedback before a nudge |
| `diamonds_start_heads_up_days` | 10 | Days sitting on a piece, or registered with no cover |
| `diamonds_notice_first/second/final` | 60 / 30 / 20 | The renewal ladder |
| `diamonds_retry_months` | 6 | Wait after an audition that didn't pass |

The anchor step (1.25) and the four weights stay in code. They're the
shape of the rubric rather than thresholds — moving the bar is a cycle
decision, re-weighting the dimensions is a different rubric.

## Things to decide while you read this

Open, and each one is a choice rather than a bug:

1. ~~The global close date~~ — **gone.** Nothing closes: registration,
   Round 0 and starting a window have no deadline, and the "last chance to
   start" nudge went with the cliff it counted back from. What's left is the
   open date, which only names the cycle.
2. **Two directors and `minScores: 2` means a recusal stalls a round.** It
   also means your own practice auditions sit unballoted for ever. A third
   voice fixes both.
3. **Is there a cap on Diamonds' size?** Pass/fail against a fixed bar and
   a cap collide. If there's a cap, the announcement must not say there are
   no fixed spots.
4. **What happens to someone who passes** — the role, the commitment,
   whether a non-qualifier can be placed at all. The bot records the pass
   and sends the news; the placement is still a conversation between the two
   of you.
5. **Does the practice cohort get the same feedback through Round 2?**
   Unanswered, and it belongs in the announcement rather than in a reply to
   whoever asks first.
6. ~~The enforcement hours~~ — **decided: midnight New York.**

**Decide:** whether 60 days is the right number. What running out costs is
settled — the same six months as quitting, so going quiet is never the cheaper
way to not finish, and an extension is how a real reason gets handled.
