# Diamonds auditions — the process

Three rounds, two cohorts, one submission per round, **run on a rolling basis**.
This doc resolves the draft into something runnable and names what is still
yours to decide.

**Most of it is now built** — see [Building it](#building-it--self-serve-by-default).
`src/config/subunits.ts` carves Diamonds out deliberately: it's the competition
unit, reached by a separate comp audition rather than placement, and this is
that audition. It isn't a rank in design doc v11, so it lives in `src/diamonds/`
and touches none of the ranks in flight.

## The calendar

**Two dates. There are no round dates.**

| | |
| --- | --- |
| Auditions open | **NOV 15** |
| Last useful Round 0 | DEC 25 *(derived)* |
| Last day to start any window | JAN 7 *(derived)* |
| Auditions close | **JAN 10** |

Everything else follows from those two plus the policy numbers, which is why
there is nothing to keep in step by hand:

```
last useful Round 0   closes − (review + window + review + window)
last window start     closes − window
```

Two reviews and two windows, at the slow end of the review range. There's
nothing else to add, because the only waiting the process imposes is the
reviewing — whatever time someone takes with their feedback is time they chose.

Regenerate it, with the announcement, any time:

```bash
npm run diamonds -- 2026-11-15 2027-01-10
```

### Rolling rounds, and why the phases went

An earlier version of this doc ran the rounds as **cohort-wide phases**:
everybody's Round 1 opened on NOV 23 and closed on DEC 13, Round 2 opened DEC
15, and so on. Five configured dates.

It bought nothing. The audition is **pass/fail against a fixed bar** — nobody is
ranked against anybody, there are no N spots to allocate — so there is no reason
anyone needs to be assessed in the same week as anyone else. All the phases
actually did was make people wait: a dancer who sent their Round 0 on NOV 16 sat
until NOV 23 for a piece that was already decided, and the directors did the
whole cohort's reviewing in one sitting on DEC 14.

So: one window, and each person moves when they move. Finish a round, we review
it, the next one opens **for them**. Which round you're in is a fact about your
record rather than about today's date — `activeRound` in
`src/diamonds/audition.ts` derives it, and nothing stores it.

**What that costs, and what pays for it.** Two things got worse and both are
handled:

1. **The wait between rounds became invisible.** Under phases you knew Round 1
   opened on the 23rd. Rolling, you've submitted and you're waiting on two
   people with no idea how long. So the turnaround is a **promise with a number
   on it** — `diamonds_review_days`, 3 — stated in the announcement, repeated on
   the panel the moment you submit, and shown to directors as "N waiting on you"
   on `/diamonds roster`.
2. **Round 1 needed something to be a response to.** The round asks what someone
   did about a named weakness, and until the weakness has been named *to them*
   there is nothing for it to measure.

   So **Round 1 can't start until their feedback has reached them.** Not a
   countdown — two earlier versions of this were a fixed number of days, first
   from the piece going up and then from registration, and a countdown is
   arbitrary in both directions: it can expire before anyone has told the dancer
   anything, which is the state it existed to prevent, and it also holds back
   someone who got their feedback on day two and is ready to work.

   Delivering the feedback *is* the transition, and since the feedback carries
   the Round 0 verdict, it is also how they learn they're through. `activeRound`
   keys off `document.deliveredAt`, `canStartWindow` refuses Round 1 without it,
   and `/diamonds assign` refuses to put a Round 1 piece up before it — which is
   what makes the ordering a property of the system rather than a habit. A DM
   that fails leaves them in Round 0 and records nothing, because a verdict
   nobody received hasn't been delivered.

   What it does *not* do is impose working time. Once the feedback is with them
   there's no clock at all until they press the button: a day or three weeks,
   their call. That's the trade — the process guarantees they've been told
   something before Round 1 can start, and leaves what they do with it to them.

**What got simpler:** no phase to miss, no cohort to be out of step with, the
reviewing spread across two months instead of stacked on two dates, and anyone
who wants to be finished before the holidays can be. Registration also asks for
a rough **estimated start date** — not binding, and the only way to see the
review stream coming before it arrives.

One timing constraint worth knowing. `src/cycles/cycle.ts` skips Nov/Dec
entirely — the training calendar has a deliberate hole there, which is exactly
why this process fits. A JAN 10 close keeps the last submissions clear of the
Jan/Feb cycle's availability poll and first sessions; pushing the close later
walks into them.

## The shape

Three pieces, one per round. The draft describes them twice — once as the
audition's contents, once as the round calendar — and they're the same three:

| Round | Piece | Who picks it | Common or individual |
| --- | --- | --- | --- |
| 0 | 1 min showing your strength | the auditionee | individual |
| 1 | 1 min "director's choice" | the directors, **per auditionee** | individual |
| 2 | 1 min final piece | the directors | **one piece, everyone** |

That split is load-bearing. Round 1 says *"your piece was specifically picked
to stretch you"* — singular, assigned. Round 2 says *"the final chosen piece"*
and the contents block says *"all dancers must learn"* — one piece for the
cohort. So Round 1 needs a per-person assignment made and delivered before its
window opens, which is a director deliverable with a deadline of its own, not a
single upload.

### Two cohorts

| | Round 0 | Rounds 1 & 2 |
| --- | --- | --- |
| **New auditionee** | submit a 1-min strength video — an existing cover or newly danced | identical |
| **Returning Diamond** | declare you're re-auditioning; receive your feedback document | identical |

A returning Diamond submits no strength video. They get a document instead:
**at least 3 evident strengths** that contributed to the team and **at most 3
opportunities to grow**, framed on competition and performance opportunities.

**They're filed and delivered one at a time, not batched.** A director can write
one any time from the announcement up to the day the Round 1 pieces go up, and
the dancer receives it the moment it's filed. Two reasons that's better than a
single due date: the writing spreads across the whole Round 0 window instead of
stacking on one evening, and whoever gets theirs on day three has two more weeks
to sit with it before Round 1 starts.

The cutoff is Round 0's result going out, because **the document *is* that
result** — it carries the pass or the fail out with it, as one message. Verdict
and reasons arrive together, the reasons first, which is how rank 12 sends a
trainee review and for the same reason: a decision at the top turns everything
under it into either a formality or a consolation prize, and the feedback is the
part worth something in both directions.

So the two halves can be done in either order and neither waits on the other
being remembered. A document written before you have both decided is **held, not
refused** — the useful moment to write it is while you are watching — and the
second verdict sends it automatically.

### Eligibility is not a gate

To **qualify** for Diamonds you must have been in at least one Major cover or
Diamonds project. But anyone may audition, explicitly as practice and for
feedback. And the round text repeats it: *"If you do not make the next round,
you can still participate for practice and feedback purposes."*

So there are two things to track per person and they're independent:

- **qualifying** — were they eligible for a spot at all
- **advancing** — did this round's review pass them forward

Which gives four states, and the one worth deciding in advance is the awkward
one: a non-qualifying auditionee who is plainly good. If the eligibility rule
stands, they can't be placed this cycle however well they dance — so say that
in the result, rather than discovering it at the end.

## The submission window

The draft's unresolved mechanic, and the best idea in it. Resolved:

> When you're ready to audition, you press **Start time now**. That button
> **shows you your piece and starts your clock at once** — there's no seeing it
> first. From that moment you have **3 days** to learn it, record it and submit.
> The round deadline is the last day a window may *close*, so the last day to
> start one is the deadline minus three.

**One action, not two.** An earlier draft separated fetching the piece from
starting the clock, so you could learn it at leisure and commit when ready. That
leaves someone holding a piece they never opened a window for, and needs two
commands where one will do. Revealing on commit is simpler, and it makes the
window mean something: the clock covers the whole job.

**Three days covers learning as well as recording, and that's deliberate.** It's
not much time for a piece chosen to stretch you — which is the point. People
don't need longer, and the thing being measured is partly what someone does
under that pressure.

### Both rounds reveal privately

Round 2's piece is the **same for everyone**, and it's still revealed
per-person rather than published on the day. The obvious objection is that it
leaks — the first person to start can tell the rest — and that's true. It's
handled with a stated rule rather than a technical guarantee, because there
isn't one available:

> Don't tell anyone what the song is, don't describe the choreography, and don't
> drop hints. If we find that someone has, **we will change the piece for
> everyone who hasn't started yet.**

What private reveal still buys, leaks aside: **nobody gains a head start by
waiting.** Published on DEC 15, the person who starts their window on JAN 7 has
had twenty-three days with the choreography and the person who starts on DEC 15 has
had three. Revealed on start, everyone gets the same three days — which is the
only way the window measures the same task for all of them.

**The threat is executable, which matters more than how it sounds.**
`assignedPiece` is stored per person per round even when the value is identical
for everyone, so swapping it for the not-yet-started set is an update to those
records and nothing else — `notYetStarted(records, 2)`. Deliberately not
everyone: resetting a running window would punish the compliant hardest, and
someone who has already submitted can't be asked to do it twice. The
announcement says so explicitly, so the people who behaved know they're safe.

### What the window is actually for

Worth being straight about, because someone will work it out and feel cheated
if the stated reason doesn't hold. The window limits **recording** time, not
learning time — start yours on the last possible day and you've had three weeks
with the piece. That's fine, and it's consistent with what both rounds ask for:
Round 1's piece is *"picked to stretch you"* and Round 2's reflects *"the
caliber at which we expect Diamonds to execute"*. Both want your best version,
not your fastest.

So the window isn't a fairness device. It does two real things: it stops
perfectionism (three days is film it, watch it, film it once more), and it
spreads submissions across three weeks instead of landing all of them on the
final night — which is the difference between a reviewable round and a
weekend of forty videos. Say that in the announcement and nobody feels tricked.

## Review and feedback

Everyone who submits gets feedback, advancing or not. That's the promise the
announcement makes twice, and it's the expensive part of the process.

Per round: directors review submissions, agree an outcome, write feedback, and
it goes out with the result. `src/trainees/review.ts` already implements this
shape, including the two rules worth keeping:

- **Ballots stay sealed** until enough are in, so the next voter isn't told
  what to say by a visible tally.
- **Feedback stays hidden until the vote settles**, so nobody is anchored by
  what was written before them — then it's sent with the result.

Settling on `trainee_min_votes` (2 of 3) rather than unanimity matters more
here than for trainees: a director who assigned someone's Round 1 piece has a
view on how it went, and a director who coaches them shouldn't be the one
voting.

## Two directors changes the quorum

You have **two** directors, not three. Mechanically that's fine — nothing
hardcodes three, `minVotes` is a parameter read from KV, and
`decision_min_votes` / `trainee_min_votes` are already `2`, which with two
directors simply means *both*. Every disagreement is a split by definition,
which routes to discussion and a recorded outcome. Two people talking it out is
what two people do.

Three things follow, and one of them is a live bug in rank 12.

### The recusal escape hatch is gone — and it stalls

Two comments in the code promise something that two directors can't deliver:

> `src/config/settings.ts:64` — *"Two rather than all three, because a director
> who coaches the trainee has no business voting on them."*
>
> `src/trainees/review.ts:9` — *"A trainee needs `trainee_min_votes` of them —
> two of three by default — because a director who coaches the trainee shouldn't
> be voting."*

The whole point of 2-of-3 was that a conflicted director could sit out and the
remaining two could still settle it. With two directors, 2-of-2 is unanimity, so
**a recusal leaves one ballot against a threshold of two — and
`reviewStatus` returns `in-review` forever.** The card never settles, never
sends a result, and nothing surfaces it as stuck. That's the exact failure the
2-of-3 design existed to prevent, now reachable in rank 12 today, not just here.

Three ways out, in the order I'd prefer them:

1. **Recruit a third voice** — an alum, a senior member, a guest judge — added to
   `config:director_ids` so 2-of-3 means what the comments say again. Best
   answer: it restores recusal *and* breaks deadlocks, and they only have to
   show up when one of you steps out.
2. **Accept single-director decisions on recusal**, by dropping `min_votes` to 1
   for that case and recording on the card that one director decided alone.
   KV-editable by design, but fiddly per-case and easy to leave at 1.
3. **Nobody recuses.** Honest, but it means the director who assigned someone's
   Round 1 piece also votes on how it went.

Either way the two comments should be corrected — they're the reasoning for a
contestable number, and right now they describe a roster you don't have.

### Sealed ballots matter more, not less

With three voters a visible tally nudges the third. With two, **the first vote
effectively decides the second** — there's nowhere to hide and no majority to
join. Keep `review.ts`'s seal exactly as it is; it's doing more work now.

### Your feedback load just went up 50%

Every number in §2 below divides by two instead of three.

## What the bot already has

Most of a round exists; none of a *process* does.

| What this needs | What's there | Where |
| --- | --- | --- |
| Self-started window, per-person deadline, reminder, lapse | rank 12's propose → approve → `due_on` | `src/trainees/audition.ts` |
| Submission link + "can a reviewer actually open this" check | oEmbed share-access check | `src/applications/videos.ts` |
| Sealed ballots, hold, split, discussion, recorded outcome | the decision model | `src/applications/decision.ts` · `src/trainees/review.ts` |
| Feedback written per director, revealed on settle, sent with result | same | `src/trainees/review.ts` |
| The announcement going out only after a human reads it | rank 6 draft → approve → publish | `src/drafts/` |
| Daily deadline sweep | the trainee daily job | `.github/workflows/trainee-daily.yml` |

## What the bot would need

| Gap | Why it isn't a small change |
| --- | --- |
| **Rounds and advancement** | Rank 12 models one attempt, pass or fail. This is three sequential rounds over a cohort that shrinks, *plus* a practice cohort that keeps submitting without advancing. Nothing models a round or carries a cohort forward. |
| **Per-person piece assignment** | Round 1 needs a piece chosen, stored and delivered per auditionee before their window can open. Rank 12 has the trainee propose their own song; here the direction reverses. |
| **The feedback documents** | One document per returning member, ≥3 strengths and ≤3 growth areas, due before Round 0 closes. A document, not a DM — needs a Drive or sheet home. |
| **Eligibility** | "Participated in a Major cover or Diamonds project" is participation history. That's rank 1/2 roster and activity — flagged off, not built. **This is the CLAUDE.md stop-and-say-so case**: I'd keep eligibility on the honour system plus a director's eye, rather than build roster history to serve it. |
| **A Diamonds roster** | "Returning Diamonds" needs to know who the current Diamonds are. Nothing stores that today. |

Scoped honestly, this is a rank of its own sitting on rank 1's roster, and it
wants rank 12 landed first so the window machinery is shared rather than
copied.

## Overlap with the trainee system

There should be, and the codebase is already shaped for it — `review.ts` reuses
`decision.ts` wholesale rather than reimplementing a vote, so Diamonds becomes
the third consumer of the same model, not a new one.

**Share the machinery:**

| Shared | Why it's the same problem |
| --- | --- |
| request → window → per-person deadline → remind → lapse | Rank 12's audition clock is this clock. Different lengths, identical shape. |
| `ExtensionRequest` | Reason, days, granted/denied, note required on denial. Already right, including that extensions can be partial. |
| The decision model | Sealed ballots, hold, split, recorded outcome, feedback hidden until settle. |
| `trainee_min_votes` reasoning | 2 of 3, because a director who assigned someone's Round 1 piece — or who coaches them — shouldn't be the deciding vote. Stronger here than for trainees. |
| The daily sweep | `trainee-daily.yml` can carry Diamonds windows too. A second cron that does the same thing on the same data is a second thing to forget. |

**Don't share the record.** Rank 12's `AuditionRecord` carries `song`,
`songLink` and `proposalStatus` because *the trainee proposes* and a coach
approves. In Diamonds the direction reverses: the piece is assigned to you. One
record serving both would leave half its fields permanently undefined, which is
how a card ends up saying the wrong thing. Extract the clock and the decision;
keep two records.

**Keep the target sets apart.** `isAuditionTarget("Diamonds")` is false, and
`test/audition.test.ts:273` asserts it. That should stay true — Diamonds isn't
reachable through a rank 12 audition, which is the same carve-out
`subunits.ts` makes for placement.

**Where the two collide on a person.** A trainee can be in a rank 12 window
(7 days, for Hearts or Spades) and a Diamonds window (3 days) in the same week,
with two deadlines and two videos owed. Worth surfacing rather than preventing —
most trainees won't qualify for a Diamonds spot anyway, so for them this is a
feedback opportunity, and that's arguably the best argument for opening it to
everyone. But a coach should be able to see both clocks on one person before
granting an extension on either.

## What I'd change

You asked. The process is sound in shape — three escalating rounds, self-paced
windows, feedback as a first-class promise rather than a courtesy, is a better
design than most auditions get. Five things I'd fix before announcing.

### 1. Pass/fail — so the bar has to be written down before anyone submits

**Settled: pass/fail against a standard**, not a ranked contest for N places.
Two good consequences. Round 2 asks one question per person — *is this Diamonds
caliber?* — which is exactly the shape `review.ts` already implements, so no
ranking machinery is needed. And the feedback becomes answerable: *"here's what
to work on"* rather than *"you were close, but someone was better"*, which is
both kinder and far easier to write.

But it moves the hard problem rather than removing it. **A ranked field
calibrates itself; a pass/fail bar doesn't.** "The caliber at which we expect
Diamonds to execute" is a vibe, not a standard. If three directors each hold
their own private bar, pass/fail quietly degrades into something worse than
ranking — inconsistent from person to person, with no comparison available to
expose it. So the bar has to be **explicit and agreed before the first
submission is watched**, not discovered while watching them. A short written
rubric on the final piece is enough: what passing looks like, in three or four
dimensions. This is new work the draft doesn't have, and it's the one thing I'd
do before the announcement goes out.

**Written up in [DIAMONDS-RUBRIC.md](DIAMONDS-RUBRIC.md)**, on your own 0–10
ladder rather than an invented scale: Technicality, Execution, Performance,
Musicality & Timing, scored against the deck's anchors. **Only Round 2 uses all
four.** Round 1 scores one named thing on the same ladder, against a number
fixed when its piece went up; Round 0 uses no numbers at all.

**Settled: the bar is 7.5** — one anchor above the 7.1 house benchmark, with no
single dimension below 6.25. Pass means *notable ability in a couple of areas*,
which is to say measurably above the median RISK dancer rather than merely
competent.

### 1b. Pass/fail only works if you'll genuinely take everyone who passes

The flip side, and worth sitting with. Pass/fail means no cap — if twelve people
clear the bar, twelve people are in. Diamonds is a competition unit, so there
may be a practical ceiling: formations, travel, costs, rehearsal logistics.

If that ceiling exists and you hit it, you'll be tempted to raise the bar to fit
the number — which is ranking, done after the fact, without telling anyone. That
is the worst of both designs. So either accept that the unit's size is whatever
the bar produces this cycle, or admit there's a cap and run it as ranked. Don't
announce pass/fail and then operate a cap.

### 2. The feedback load compounds, and two directors makes it the real risk

This is the one most likely to break the process. Everyone who submits gets
written feedback, non-advancers are explicitly invited to keep going, so the
field **doesn't shrink** as rounds progress. Twenty auditionees over three
rounds is sixty sets of written feedback — **thirty each, between two of you** —
on top of the returning members' documents.

With three directors I'd have called tiering advisable. With two it's
**mandatory**: prose for people still advancing, a short structured form (the
same rubric dimensions from §1, scored with a line each — there's a worked
example in [DIAMONDS-RUBRIC.md](DIAMONDS-RUBRIC.md)) for the practice cohort
after Round 0. A stated smaller promise kept beats a generous
one that arrives in March, and thirty prose write-ups per director is how you
get March.

### 3. A live component — now optional rather than filling a hole

**You were right and this needs downgrading.** I had coachability as something
only a live session could test. It isn't: Round 1 *is* the coachability round —
a piece chosen to expose your weakest dimension, and advancement turning on what
you did with it. That's coachability measured over three weeks of real work,
which is better evidence than an hour on a call.

So the gap I was worried about is mostly closed, and I'd no longer argue for a
live session as a *requirement*. What it still adds is narrower: you'd have met
the person before committing them to a competition unit, and you'd see one
correction land in real time rather than inferred from a delta.

If you do want it, the shape still holds — **remote, not in person**. Travel,
shifts, caring commitments and not being local have nothing to do with dancing,
and a gate like that filters on circumstance. One ~1-hour video call on the
common final piece, scheduled off the availability poll already in
`src/cycles/cycle.ts`, one makeup slot, and **not separately pass/fail**. State
the floor up front — room to dance, a device that frames you full-body, and a
studio or 1:1 alternative for anyone that doesn't work for — so nobody has to
disclose why they're asking.

What a call still can't test is spacing and holding a formation in a room. That
belongs after results, as the first rehearsal, where requiring attendance is
fair because they've accepted the commitment by then.

### 4. The eligibility gate is fine — Majors being open is what makes it fine

To answer what I meant: I was worried about a **closed loop**. If Major covers
were themselves selective, then you'd need a Major to reach Diamonds and
somebody's permission to reach a Major, and "anyone can audition" would be
decoration — a newcomer could never actually get in, however good they were.

**Majors are open, so the loop doesn't exist.** The rule is a *participation*
requirement, not a selection one, and anyone can satisfy it by showing up for
one project. "Newcomers can't immediately join Diamonds" is then a defensible
rule rather than a trap: you have to have done one thing with RISK first. I'd
keep it exactly as it is.

One change, though, and it's cheap. **The announcement states the requirement
but not the way through it**, which makes it read like a wall to anyone who
doesn't already know Majors are open. Say the path out loud: *haven't done a
Major yet? Audition anyway for the feedback — and doing a Major this season
makes you eligible next cycle.* Same rule, and it turns a rejection into a
roadmap.

That also answers the awkward case from before. A non-qualifying auditionee who
meets the bar now gets a real answer instead of a technicality: **"you met the
standard — do a Major cover and you're in next cycle."** If you want to be
generous you can say their pass carries over, though be aware the bar may have
moved by then; promising a fresh look is the safer version of the same warmth.

### 5. Round 0 is a gate, and pass/fail — settled

**Round 0 ends in a pass or a fail**, for both cohorts: does this person belong
in the process. It is a judgment the two of you make, with the reasons written
down, and it is not scored.

That is a change from an earlier version, which made Round 0 a *baseline* —
scored on the four dimensions, with the lowest becoming the Round 1 target and
its score becoming the before-number in Round 1's delta. Nobody was cut there,
because cutting someone would have meant throwing away a baseline rather than
using it.

**What killed it: Round 0 and Round 1 are not comparable reads.** Round 0 is a
cover the dancer picked. Round 1 is a piece they were handed, with three days on
it. Scoring "weak arms" at 7 on the first and 5.5 on the second is not someone
getting worse — it is two different questions sharing a scale, and the delta
between them is noise with a direction. Pick a flattering cover and you start
high, so improving honestly reads as regression and gets you cut at Round 1. The
people best at choosing a cover were the ones most at risk from it, and the
whole mechanism was invisible to everyone involved.

So the two jobs are separated. Round 0 decides, and that is all it does; **the
before-number is set deliberately at assignment**, by the same hand that picks
the piece, in the one sitting where it can only be an honest read — the video it
will be compared against does not exist yet. Still a judgment, but a judgment of
the same thing Round 1 will score, by the same people, against the piece they
chose to test it with.

The documents themselves are still the quietest risk in the whole process: one
per returning member, at least three strengths and up to three growth areas, the
most writing in the project, and the only deliverable the draft gave no date.
`npm run diamonds` dates them to Round 0's deadline. With two of you, write them
before the announcement goes out if you can — they're the one thing that can't
be done in the gaps.

## Building it — self-serve by default

**Settled: the bot hands out the pieces and runs the windows.** The goal is to
reduce coordination to the only two steps that genuinely need a human:

| Needs a director | Self-serve |
| --- | --- |
| Scoring a round — both of you, sealed | Registering, and saying when you'll go |
| Writing feedback, before or after that | Starting your window, which hands over the piece |
| Putting up that person's next piece | Submitting |
| Sending a settled result | Checking where you are, and who you're waiting on |
| Granting an extension when asked | Checking where you are, and who you're waiting on |

Everything in the right-hand column works at 2am with nobody to ask, which is
why each refusal in the code names the thing that would need to change — and why
*"your piece isn't up yet"* explicitly says nothing is wrong on their end, since
the fix belongs to a director.

### The commands

```
/diamonds register   put your name down, and estimate when you'll send Round 0
/diamonds plan       say when you'll start the round you're in, and get reminded
/diamonds start      the panel, and the [Start time now] button
/diamonds submit     hand in a link, for the round you're in
/diamonds status     where you are, what's next, who you're waiting on
/diamonds withdraw   take yourself off the list

/diamonds config     directors: what this will run on — read before the flag
/diamonds schedule   directors: set the open and close dates, read it back
/diamonds add        directors: put someone on after auditions have closed
/diamonds assign     directors: one person's piece — plus, for Round 1, what it
                     tests and the number that thing starts at
/diamonds assign-all directors: one piece to everyone who hasn't started — Round 2's
/diamonds extend     directors: add days to an open window
/diamonds score      directors: your sealed ballot on whichever round is waiting
/diamonds result     directors: read a settled result back, then send it
/diamonds feedback   directors: leave feedback — any time, before or after your ballot
/diamonds roster     directors: who's waiting on you, and who you're waiting on
```

Neither `start` nor `submit` takes a round. It's derived from the dancer's own
record: someone who has to know they're in Round 1 in order to submit is someone
the process has already failed.

`register` asks nothing about eligibility. Whether a Major cover or a Diamonds
project has been done decides whether a *pass can place someone*, which is a
question at the end rather than the start — and asking it here would collect a
self-reported answer no decision was ever going to be made on.

### The estimate, and why it's per round

`register` asks roughly when they'll send Round 0; `/diamonds plan` says the same
for each round after that. Stored on the round, not on the person, because each
round is a separate decision about when to find three days — and because an
estimate guessed in November about a round they'll reach in December isn't a
plan, it's a mood.

**Nothing is ever refused on the strength of it**, and every message that
mentions it says so. What it buys is two things:

- A reminder on the morning they picked. This is the one part of the process
  nobody schedules for them: no rehearsal in the diary, no phase opening on a
  Monday, nothing but a close date eight weeks out. A day someone chose
  themselves is much easier to hit than no day at all.
- Directors can see the review stream coming instead of discovering it.

The date itself *is* validated, though — not to hold anyone to it, but because a
plan the bot can't honour is worse than no plan. A day inside Round 1's working
gap, or past the last possible start, or already gone, is refused with the real
date instead. Otherwise they'd be waiting for a reminder on a day they were
never able to start.

Moving the date clears the reminder marker, so the reminder moves with it rather
than being silently spent.

`config` and `schedule` are the only two that run while the flag is off, because
reading the timeline and fixing it are *how you decide* whether to turn the flag
on. `config` comes first — you look, then change what's wrong. `schedule` reads
the whole thing back on every write, so there's no separate re-check step.

Fetching and starting are **one action**, not two. An earlier draft separated
them — learn it on your own time, then commit — but a fetch that doesn't start
the clock is a way to hold the choreography with no window open, which is a way
to get more than three days with it. One button, with the warning above it.

### The sweep

Five messages, each once per person per round, and never two to one person
in one run:

| When | What | Why |
| --- | --- | --- |
| 1 day before their own window shuts | the deadline, extension door open | their close time is personal — no two people share one |
| 3 days before the last possible start | last chance | the only message keyed to the shared calendar, because this cliff really is shared |
| the morning they said they'd start | you picked today | the one date in the whole process that is theirs, so it outranks anything generic |
| 10 days after their window became startable | your piece has been waiting | counted from *them*, not the calendar: the close date can be two months off, and a nudge pegged to it would let someone sit on a piece for seven weeks in silence |
| 3 days before the last useful Round 0 | you registered but never sent a cover | nothing else can reach this person: no window to key off, no piece to wait on |

Listed in priority order, which is also the order the code checks them in. At
most one goes out per person per run.

### Where it lives

`src/diamonds/`, its own module. **It mirrors rank 12's clock rather than
importing it** — deliberately, and the reasoning is in the file header. Rank 12
(`src/trainees/`) is ~5,000 lines of uncommitted work in flight; refactoring a
shared clock out from underneath it now would be worse than duplicating the
shape and extracting later, which stays mechanical as long as the names line up.
Two things stay unshared on purpose: the record (rank 12's trainee *proposes* a
song, so `song`/`songLink`/`proposalStatus` would be permanently undefined here,
where the piece is assigned) and the target set — `isAuditionTarget("Diamonds")`
is false and stays false.

### Built so far

`src/diamonds/audition.ts` — the pure core:

- the window clock: opens on request, closes after N days, partial extensions on
  top, lapses when it runs out
- `lastStartAt` — the deadline minus the window, in one place rather than three
- the four permission checks, each with a reason written for the person reading it
- `visiblePiece` / `startWarning` / `ROUND_REVEAL` — the reveal rule per round
  and the warning text in one place, since it appears in the announcement, on
  the button and in `/diamonds status`
- `notYetStarted` — who a leaked Round 2 piece gets swapped for, so the
  announcement's consequence is something you can actually carry out
- `round2Outcome` — **derived** from the scores and the current bar, so moving
  the bar re-derives every unsent result together; a sent result freezes
- the reminder, a day out, once — plus a nudge for anyone who still hasn't
  started, keyed to the *last start date* rather than the deadline, since that's
  the moment the option disappears
- the returning-member document: the spec's bounds enforced where it's written
  (three strengths, at most three growth areas), a rolling filing window that
  closes when the pieces go up, and a delivery queue
- `passesFinal` — Round 2 only: the weighted score (40/30/20/10) ≥ 7.5 with
  nothing below 6, so both 10/10/5/5 and a *zero* in musicality fail
- `overallBand` — derives the deck's holistic anchor by counting notables
- `fixTarget` — called by `/diamonds assign` for Round 1, never on its own, and
  it **refuses to move a target already fixed**. It stores the Round 1 target in
  words and `targetBefore`, that one thing's score on the 0–10 ladder. Free text
  rather than a dimension, because "Execution" is not something anyone can go
  and practise and "elbows collapse on extensions" is — which is also why it has
  to be specific enough that two people watching the same video would score it
  the same way. Fixed at assignment because that is the one moment it can only
  be honest: the video it will be compared to does not exist yet
- `advancesRound1` — Round 1 only: your delta rule on the one named thing, both
  branches, with the reason recorded. No weighting involved — one thing, so
  there is nothing to weight

Every score also records the bar, floor and weights it was judged against, so
if the standard moves between cycles the old results still say what they
cleared. Every policy number is a parameter, never a constant — the same pattern as
`minVotes` in `review.ts`, so the bar, floor, window length and required step
can move to KV without touching the logic. `ANCHOR_STEP` is the one constant,
because 1.25 is a property of the scoring ladder rather than a policy choice.

### Also built

`src/diamonds/config.ts` — **two** dates and eight numbers, all from KV. The
dates default to the announced timeline rather than refusing when KV is empty: a
bot that disagrees with the announcement about a deadline is the worse of the
two failures, and an empty namespace would hand us one silently. Opening
resolves to 00:01 and closing to 23:59 in the crew's timezone, because that is
what the announcement means by "open NOV 15" and "closes JAN 10". The bar,
floor, window length, review turnaround and Round 1 gap all read
`config:diamonds_*`, so the bar can move without a deploy.

`src/diamonds/card.ts` — one panel for all three rounds, because it answers one
question (what can I do right now) and three panels would be three places for
the answer to drift. Plus the director's readout, grouped by **whose move it
is** rather than by round — nobody shares a round any more, so the only useful
question is what you owe anyone today. That grouping is also why it can't lean
on `windowState` alone: Round 0 has no assigned piece by design, so it reads as
"unavailable" forever, which for a newcomer who hasn't filmed anything means the
opposite of waiting on us.

`src/diamonds/flow.ts` — KV storage keyed by person, not by attempt: a Diamonds
audition is one process with three rounds, not three tries. Registration is
idempotent and refuses only once auditions have closed. `fileFeedback` is one
path for both cohorts, because delivering it is what opens Round 1 and a second
path would be a second way for that not to happen; filing and delivering are one
action, since a queue of filed-but-unsent feedback is a queue of people blocked
without knowing it. Assignment DMs the dancer, and refuses to put a Round 1
piece up before their feedback has gone — the ordering the whole rule rests on.
`assign-all` skips anyone mid-window or already submitted, which is also what
makes it the reassignment path if the Round 2 piece ever gets out.

`src/diamonds/handlers.ts` — gating follows rank 12 rather than
`commands/gate.ts`: dance guild, `#diamonds-bot`, and the director check per
subcommand, since five of the thirteen are for the people auditioning. Every
reply is ephemeral and every result is a DM, because in a reveal-on-start round
the piece must not land anywhere a second person can read it.

`/jobs/diamonds-daily` and `.github/workflows/diamonds-daily.yml` — the sweep
described above, on its own endpoint rather than a line in trainee-daily. It
reads the flag itself, so turning Diamonds off stops the DMs too.

90 tests in `test/diamonds.test.ts` and 87 in `test/diamondsFlow.test.ts`. 703
across the suite.

### Scoring

**Sealed ballots, one per director, keyed by their id.** Nobody sees anybody
else's until every required ballot is in — `/diamonds score` replies with a
count and nothing more. The seal matters more with two directors than it would
with three: with three a visible tally nudges the third, with two the first
number effectively decides the second, because there is nowhere to hide and no
majority to join.

The tally is the **mean**, not a vote. These are measurements on a shared ladder
rather than opinions to be counted — two directors who say 6 and 7 aren't
disagreeing about an outcome, they're bracketing a number. Where they *are* far
apart, `ballotSplits` says so rather than the mean quietly splitting the
difference: anything more than one anchor step (1.25) apart is flagged, because
the mean of 4 and 9 looks exactly like the mean of 6 and 7 and means something
completely different. Surfaced, not refused — two directors have no tiebreak, so
it's a conversation, and rescoring overwrites a ballot rather than adding one.

Each round asks for a different ballot, which `ballotComplete` enforces:

| Round | What a ballot carries | What it decides |
| --- | --- | --- |
| 0 | pass or fail, no numbers | whether they're in the process at all |
| 1 | one named thing, 0–10 | the delta — advanced, or practice |
| 2 | the four dimensions | the bar — passed, or not |

**Round 0 is a vote, not a mean.** Both verdicts agree and it settles; one each
and it settles *never*, which is correct — two directors have no majority and a
decision with two values has no average to take, so a split reports itself as a
split and the two of you talk. Inventing a tiebreak there would be inventing a
third opinion.

Nothing crosses from one round's judgment to the next. Round 0 produces no
number, and Round 1's before-number comes from `fixTarget` at assignment rather
than from anything Round 0 said — see §5 for the failure that forced them
apart.

**Outcomes are derived right up until the result is sent.** `settleRound` reads
the ballots and the *current* bar, so moving the bar re-derives everyone at once
— otherwise two people in the same cohort get judged against different numbers
depending on which evening someone ran a command. Once a result has gone out
that stops being true, so `scoredAgainst` is recorded at send time and a sent
result is read back rather than recomputed.

Sending is its own action, behind a preview: `/diamonds result` renders exactly
what the dancer will read and puts one red button under it. It's the only
irreversible step in the process, and a failed DM records nothing at all — a
result marked sent that never arrived is the worst of both.

### Feedback, the way rank 12 does it

`/diamonds feedback` is **written whenever suits — before or after your ballot.**
The useful moment to write something down is while you're watching, which is not
necessarily the moment you've made up your mind, and `src/trainees/review.ts`
already works this way.

What it opens depends on the round, because the rounds want different things:

- **Round 0** — the written document. One shared artifact with the spec's shape
  (three-plus strengths, at most three growth areas), because its job is to give
  the dancer something to work from.
- **Rounds 1 and 2** — one free-text note per director, keyed by their id. A
  director saying what they saw, in their own words. A form here would flatten
  that into the same four paragraphs every time.

**The text stays sealed until the round settles**, and that's tied to settlement
rather than to everyone having written — rank 12's reasoning, which carries
exactly: the director sitting this one out is never going to write, and holding
the others' words hostage to that would mean the dancer reads none of it. The
receipt says *"Feedback: 1 written (@d1)"* and no more.

`composeFeedback` joins the notes in roster order under their own heading in the
result, rather than weaving them into the generated verdict — a director's words
should arrive as their words, not as part of a machine's sentence.

**The Round 0 document is held, not refused** — and it is also how Round 0's
result is sent, since the verdict travels inside it. A document written before
either of you has decided waits; the second verdict releases it, with nobody
having to remember to file it again. Whichever of the two lands second sends it,
which is the same pattern as the reveal. A split holds it too, and says which
way each of you went.

**What is still enforced:** `/diamonds assign` refuses to put a Round 1 piece up
before the feedback has reached them, because Round 1 is a response to it — and
it refuses a Round 1 piece with no target or no starting number, because that is
a round with nothing to measure. So the ordering is `call it ⇄ write it` in
either order, then `deliver` automatically, then `assign` *with the target and
its number*, then they start.

**The documented stall is surfaced.** A recusal leaves one ballot against a
threshold of two and the round settles never; `/diamonds roster` shows
`⚠️ 1 of 2 ballots — waiting on another director` on the row, so it can't sit
there unnoticed. `diamonds_min_scores` is in KV precisely so it can drop to 1
for a case where one of you has to sit out — see the two directors section.

**Not built:** nothing in the dancer- or director-facing flow. What's left is
the roster page's one remaining nag — nobody is *told* about a stalled tally
unless they run `/diamonds roster` — and placement, which is what happens to
someone who passes and whether a non-qualifier can be placed at all.

### Before it runs

**The flag goes last, and it is not the only step.** Flipping it with the
timeline still on its shipped defaults would have the bot quoting dates the
announcement never mentioned, which is why `/diamonds config` exists and why it
works while the flag is off.

In order:

1. `CH_DIAMONDS_BOT` is in `wrangler.toml` as `diamonds-bot` — create that
   channel in the dance server, or change the value. `npm run doctor` checks it.
2. `npm run register` to register `/diamonds` as a **guild** command.
3. `config:role.diamonds` in KV — the Diamonds role id. It's what decides
   returning vs new, and so whether Round 0 asks someone for a video. With it
   unset everyone counts as new, which is the safe way round: it asks for a
   video that won't be held against them. `/diamonds config` says which way it
   currently is.
4. `/diamonds config` — **look first.** Read the two dates against the
   announcement you're about to post. A `·` means a value is still the shipped
   default, which is a fine answer where it matches and the only way to know is
   to look.
5. `/diamonds schedule` only if something's wrong. It validates the dates,
   writes them, and reads the whole timeline straight back — including whether
   the result can be run at all. So there is no separate re-check afterwards;
   setting a date *is* checking it.
6. **Then** flip `config:features.diamonds` to `true`. Until then every other
   subcommand refuses, which is what stops anyone registering for a process that
   hasn't been announced.

Add `diamonds-daily.yml` to whatever runs `trainee-daily.yml`; it uses the same
two secrets and needs no new ones.

### The fallback, if it ever has to come off the bot

Run it on a sheet: one row per auditionee carrying cohort, their estimated start
date, each director's Round 0 pass/fail, the Round 1 target in words, its
before-score and the day it was fixed, the assigned piece and when it went up,
window start, submitted link, and the Round 1 after-score. One row per person across all three rounds — not a tab per
round, or you lose the thing the whole design turns on, which is that each
person has their own position in the process.

## Still open

Answered: nothing has gone out; **pass/fail**, not ranked; **two directors**;
Round 0 submissions may be an existing cover **from the last 6 months**;
extensions are **partial days granted by a director**; the eligibility gate
**stays** (Majors are open, so there's a path through); Round 0 is
**registration** for returners.

**The critical path, and rolling rounds shortened it:**

1. **Set up and post the announcement on NOV 15.** The text is generated and
   ready; the six setup steps are in
   [Before it runs](#before-it-runs), with the flag last.
2. **Calibrate against the deck — before NOV 15, not after.** Under phases
   there were three weeks between the announcement and the first thing needing a
   score. Rolling, someone can submit Round 0 on the 15th and you've promised a
   review by the 18th, so both of you need to have scored two or three reference
   videos and compared *first*. The delta model rests on the before-number being
   a real read, and you now set that number yourselves at assignment — which
   makes calibration load-bearing rather than tidy.
3. **Decide what happens to someone who passes.** The one thing the bot has no
   answer for: a pass records `passed` and sends the news, and the placement —
   the role, the commitment, and whether a non-qualifier can be placed at all —
   is still a conversation between the two of you.
4. **Write everyone's feedback when you get to them.** Both cohorts, one
   command. It's the gate on Round 1, so nothing of theirs moves until it's
   sent, and `/diamonds roster` lists who's owed one as the thing blocking
   them. A newcomer has to send a cover first; a returning Diamond doesn't.
5. **A third voice for recusals and deadlocks** — and fix the two stale comments
   while you're there. (Two directors, above. Affects rank 12 today.)

**Can wait, but decide them rather than discovering them:**

7. **Is there a practical cap on Diamonds' size?** Pass/fail and a cap collide.
   (§1b)
8. **Live remote session in Round 2** — optional now that Round 1 covers
   coachability. If you want one, it lands around JAN 7–10. (§3)
9. **Round 1's step size** — one anchor (+1.25), or two?
10. **Are auditionees told their number?** Today they are: the Round 1 panel
    quotes the before-number when the piece goes up, and the result quotes both
    ends. That seems right — it is the one number the round turns on, and a
    delta you can't see the start of is a verdict rather than a measurement —
    but it is a choice, and reversible.

Treating as settled unless you say otherwise: **tiered feedback** for the
practice cohort (§2), and **Round 0 as a pass/fail gate** carrying its own
written feedback either way (§5).

## Appendix: the announcement

Generated, so it can't drift from the calendar:

```bash
npm run diamonds -- <your announcement date>
```

It prints the text with every date filled in, ready to paste. The placeholder
(`[request for it from the bot]`) is gone and the window mechanic is spelled
out, since that's the one part nobody can guess.

It now states that there's no fixed number of spots, since it's pass/fail.
**That line commits you to taking everyone who clears the bar** — delete it if
§1b is unresolved, because it's much worse to walk back than to never say.

One thing it still doesn't say, because it's unanswered above: whether the
practice cohort gets the same feedback through Round 2. That belongs in the
announcement rather than in a reply to whoever asks first.

Send it through rank 6 — `createDraft` with a dance-guild target — so it gets
read by a human before it posts, rather than pasted straight in.
