# Every message, as text you can edit

Current as of the warm pass. Four rules hold throughout — if an edit should
break one, say so and I'll argue with you rather than just doing it:

1. **No scores.** Nothing a dancer reads contains a number out of the rubric.
   The types enforce it: `resultMessage` can't reach one.
2. **No reassurance about their worth.** No "this isn't a judgement on your
   dancing". The decision goes in the first sentence, flat.
3. **No advertising discretion.** The escape hatches exist; the bot points at a
   director for *questions*, never for a deadline to be moved.
4. **Each thing said once.** The wrapper owns the verdict, the document owns the
   feedback.

Warmth is not on that list. Openers acknowledge the work, closes offer to
explain, and congratulations are allowed to sound like congratulations.

**How to edit.** Change the words inside the code blocks. Leave the `{tokens}`
alone — they're filled in at send time. Tell me when you're done.

**Tokens**

| Token | Becomes |
| --- | --- |
| `{round}` | 0, 1 or 2 |
| `{dancer}` | a mention, or their display name on a card |
| `{days}` `{left}` | a number of days |
| `{window}` | 3 — the days in a window |
| `{run}` | 60 — the days for all three rounds |
| `{review}` | 1–5 — the turnaround range |
| `{needed}` | 16 — the process end to end |
| `{months}` | 6 — the wait after an audition that didn't go through |
| `{date}` `{closes}` `{ends}` `{again}` | a date Discord renders in the reader's timezone |
| `{document}` | the written feedback, M9b |
| `{feedback}` | the directors' written notes on a round |
| `{note}` `{reason}` | something a director or dancer wrote |

Numbers are kept — they just stay with the directors. The review card, the
ballot receipt and `/diamonds roster` all still show them. **Instruments on one
side, prose on the other.**

---

## To a dancer, on its own schedule

The daily sweep. **One per person per morning**, first match wins.

### M1 · Their open window shuts tomorrow

```
⏰ **Round {round} closes {closes}.** Submit with `/diamonds submit link:<url>` before then.
If something's gone wrong, there's an **Ask for more time** button on your panel — better to use it now than after.
```

### M4 · On the list 10 days with no cover

Only reachable through `/diamonds add` — registering is sending the cover.

```
**Round 0 — we don't have your cover yet.**

A director put you on the Diamonds list rather than you registering yourself, so this may well be the first you've heard of it. Round 0 is a video of your own choosing, and an existing one from the last six months is absolutely fine — nothing to film.

Send it over with `/diamonds submit link:<url>` whenever suits. If you're not sure what this is, ask a director and they'll fill you in.
```

### M5 · Ten days left of their 60

```
**{left} days left on your audition.**

All three rounds need to be finished by {ends} — the {run} days run from when you registered. A round takes {window} days and we turn feedback round within {review}, so there's still room to do this comfortably.

If you're not sure where you are, `/diamonds status` will tell you, and a director can help if something's unclear.
```

### M6 · The 60 ran out with rounds unfinished

```
**Your audition has closed.**

The {run} days for all three rounds are up, so this one finishes without a result. Thanks for the part of it you did.

**You can audition again from {again}.** Registering then starts a new audition from Round 0.

If something got in the way of this one, do say so to a director — it's useful for us to know.
```

### M7 · Membership date passed with no re-audition

Sent *after* the role has come off.

```
**Your Diamonds membership has ended.**

It ran to {date}, and membership is renewed by re-auditioning — so the role has come off for now.

**You can re-audition whenever you like.** Register and you go through the three rounds like anyone else; passing puts you back on with a new date. We'd be glad to see you go again.

Any questions, just ask a director.
```

### M8 · The renewal ladder

Each rung once, most urgent only, silent while a re-audition is live.

**M8a — 60 days out**

```
**Your Diamonds membership runs to {date}** — about two months off.

Membership is renewed by re-auditioning, and passing sets a new date. Going earlier in the half of the year gives you a longer next term, so there's something in it for going sooner.

Nothing to do today — just worth knowing the date. Any questions, ask a director.
```

**M8b — 30 days out**

```
**A month to {date}**, when your Diamonds membership is up for renewal.

A re-audition takes about {needed} days end to end — three rounds, two windows and our turnaround — so this is a good point to start thinking about which week suits. `/diamonds status` has where you stand.

Any questions, ask a director.
```

**M8c — 20 days out**

```
**{left} days to {date}.**

That's about as long as a re-audition takes, so renewing this term means starting about now. If you haven't re-auditioned by {date} the Diamonds role comes off, and you'd be welcome to audition again whenever you like.

Any questions, ask a director.
```

**M8d — replaces all three** when their {months}-month wait outruns their date.
Fires for someone who dropped or lost an audition and is still inside the wait
when their membership expires, so it must not tell them to re-audition.

```
**Your Diamonds membership runs to {date}.**

You can't re-audition before {again} — that's the {months}-month wait after an audition that didn't go through, and it runs past your renewal date. So as things stand the role comes off on {date}.

Worth a word with a director if you'd like to talk it through.
```

## To a dancer, because a director did something

### M9 · Round 0 passed

Held until the feedback is written **and** the Round 1 piece is up, so it's one
message with the real start button on it.

```
**Round 0 — your result**

Thanks for sending this in. **You're through to Round 1** — nicely done.

{document}

**Round 1 is a piece we've picked for you**, chosen to look at one specific thing. We'll tell you what that thing is when it goes up, and we'll be looking at the same thing again afterwards.
{start warning}

Have a proper read of the above first, and press it when you've got {window} days to give it. If anything here needs explaining, ask either of us — we'd rather talk it through than have you guess.
```

**M9a — `{start warning}`**, shared by every start button, so editing it changes
the warning everywhere:

```
**Pressing this shows you the piece and starts your clock.** You then have {window} days to learn it, record it and submit. It can't be undone.
```

**M9b — `{document}`**, the written feedback. **No verdict in here** — the
wrapper says that.

```
{what the directors wrote}

**What you brought**
· {strength}
· {strength}
· {strength}

**Where to grow**
· {growth area}
```

### M10 · Round 0 not taken through

```
**Round 0 — your result**

Thanks for putting this together. We've decided not to take it through to Round 1 — the reasons are below, and they're worth reading properly.

{document}

**If you'd like to dance Rounds 1 and 2 as practice, you're very welcome to.** The button below sets it up: the same pieces, the same {window}-day windows, the same written feedback from both of us, and no verdict at the end. It costs you nothing and it doesn't change this result.

Any questions about the feedback, just ask — either of us is glad to go through it with you.
```

### M11 · Round 1 — through

```
**Diamonds {year} — Round 1**

Thanks for sending this in. **You're through to Round 2** — well done.

{feedback}

**Round 2 is the Director's Choice piece** — one piece, the same for everyone. It'll arrive here once it's assigned, and you'll have {window} days with it from the moment you start.

Any questions, just ask.
```

### M12 · Round 1 — not through

Every failure offers practice, as the dancer's own button.

```
**Diamonds {year} — Round 1**

Thanks for the work you put into this. We've decided not to take it through to Round 2 — the reasons are below.

{feedback}

You're welcome to audition again from {again}, and we'd be glad to see you back.

**If you'd like to dance Round 2 as practice, you're very welcome to.** The button below sets it up: the same piece as everyone, the same {window} days, the same written feedback, and no verdict at the end of it. It costs you nothing and doesn't change this result.

Any questions about the feedback, just ask — either of us is glad to go through it with you.
```

### M14 · Round 2 — passed

```
**Diamonds {year} — Round 2**

**You've passed — welcome to Diamonds.** Congratulations, and thank you for the work you put into all three rounds.

{feedback}

**Your membership runs to {date}.** Membership is renewed by re-auditioning, and re-auditioning earlier in the half of the year gives you a longer next term. We'll remind you well ahead of the date.

One of us will be in touch about what happens next. Any questions in the meantime, just ask.
```

### M15 · Round 2 — not through

```
**Diamonds {year} — Round 2**

Thanks for the work you put into all three rounds. We've decided not to take this one through — the reasons are below.

{feedback}

You're welcome to audition again from {again}, and we'd be glad to see you back.

Any questions about the feedback, just ask — either of us is glad to go through it with you.
```

### M16 · Any practice round

```
**Diamonds {year} — Round {round}, practice**

Thanks for dancing it. This round was practice, so there's no pass or fail attached and nothing is recorded against you — here's what we saw.

{feedback}

Your next piece will arrive here the same way.

Any questions, just ask.
```

*(After Round 2: "That's the end of the run, and we're glad you did it. You're
welcome to audition for real whenever you like.")*

### M17 · A piece goes up

The panel as a DM. Short, because for Round 1 it's the second start button
they've seen — M9 explained the mechanic.

```
**Round {round} · Diamonds {year}**
**Your piece is ready.** Start it whenever you like — there's no deadline on starting, and nobody needs to be around for it.

{start warning}
{what this round is looking at}
{days left}
```

**M17a — `{what this round is looking at}`**, Round 1 only, and **never a
number**:

```
**What this round is looking at:** {the named thing}.
We noted where that sat before this piece went up, and we'll look at the same thing again afterwards. Everything else still counts — that one thing is what the round turns on.
```

**M17b — `{days left}`**, on every panel where the next move is theirs:

```
⏳ **All three rounds by {ends}** — {run} days from when you registered, and **{left}** left. The whole thing takes about {needed} days of actual process, so there's room; if you need more, ask a director before the date rather than after.
```

**M17c —** which becomes this once it's gone:

```
⌛ **Your {run} days ran out {ends}.** Talk to a director — they can put you back on the list with a fresh {run} days.
```

### M18 · An extension granted

```
⏳ **That's granted** — Round {round} now closes {closes}. {days} extra days.
```

### M19 · An extension denied

```
**We can't give you the extra time on this one**, so your deadline stands as it was.
> {note}

Sorry to say no. If any of that needs explaining, ask a director.
```

### M20 · `/diamonds grant`

```
💎 **Your Diamonds membership is on the books until {date}.**

Diamonds is re-auditioned rather than permanent — re-audition before then and it renews, and going early in the half is worth a longer next term. You'll get reminders well ahead of the date; there's nothing to do now.
```

### M21 · `/diamonds add` — somebody put on who owes a cover

```
**Round 0 · Diamonds {year}**
📼 **You're on the list, and we need a cover from you.** A director put you on rather than you registering, so this may be news.

Your own choice of piece, and an existing one from the last six months is fine — you don't have to film anything new. It's judged as a yes or a no, not scored: does this belong in the process. Either way you get written feedback.
The button below, or `/diamonds submit link:<url>`.
```

## To a dancer, answering them

### M22 · After **Ask for more time**

```
⏳ **Asked.** The directors have it, and they'll answer either way. **Your deadline is still running** until they do, so keep working if you can — a granted extension on a submitted round is a much better problem than the other way round.
```

### M23 · The withdrawal warning

```
⚠️ **Withdrawing starts the {months}-month wait.** Dropping out counts the same as an audition that didn't go through — otherwise leaving early would be a way around it — so you wouldn't be able to register again for {months} months, and you'd come back owing a Round 0 cover.

**If you just need more time, you don't need this.** There's an **Ask for more time** button on your panel while a window is open, and if it's something bigger than that, have a word with a director first. Either is far easier than undoing this.
```

### M24 · After confirming a withdrawal

```
You're off the list, and the wait has started. Thanks for telling us rather than going quiet — and do talk to a director if something's happened, rather than sitting with it.
```

### M24a · After taking the practice offer

```
**You're down for {Rounds 1 and 2 | Round 2} as practice.** The result you've had doesn't change, and nothing from here is judged.
```

### M24d · Refusals they might hit

```
Your piece isn't up yet — it'll arrive here as soon as it is, and there's nothing you need to do in the meantime.
```

```
Your Round 0 feedback hasn't gone out yet, and Round 1 is a response to it — so it'll arrive together with your piece. Nothing to do yet.
```

```
Your {run} days ran out on {ends}, so this audition is closed. **Talk to a director** — they can put you back on the list with a fresh {run} days, picking up where you left off, and they'd rather do that than lose you to a calendar.
```

## To the directors

Numbers live here, and only here.

### M25 · A dancer asks for days — in #audition-review

```
⏳ **{dancer} is asking for {days} more days** on their Round {round} window ({window} days).
> {reason}

Their deadline is still running while this sits here, so it's worth answering today either way. A denial needs a reason — they'll be told what you write.
```

**M25a — once answered**, in place of the above:

```
✅ **{dancer} asked for {days} more days** on their Round {round} window ({window} days).
> {reason}

Granted by {director} {when}.
```

### M26 · Somebody's 60 days ran out — #directors-bot-confirmation

```
⌛ **{dancer}'s audition has closed** — {run} days up with the rounds unfinished.
`/diamonds add` puts them back on if you want to.
```

### M27 · Somebody came off the role — #directors-bot-confirmation

```
💎 **{dancer} has come off Diamonds** — their membership ran out today with no re-audition.
```

### M28 · Ballots owed past the promised turnaround

The only message that repeats. Daily until the list empties.

```
⏰ **{count} waiting on a ballot longer than the {review} days we promise:**
· {dancer} — Round {round}, **{days} days**

Their {run} days keep running while they wait, so this is the thing most likely to cost somebody an audition they'd have finished. `/diamonds roster` has the rest.
```

### M29 · A review card couldn't be posted

```
⚠️ {dancer} submitted Round {round}, and the review card couldn't be posted to #audition-review. **The submission is recorded** — score it from `/diamonds roster`.
```

**M26 and M27** add this when the DM also failed:

```
⚠️ Couldn't DM them, so they've not been told.
```

### M30 · Refused a result with no feedback

The reason the written note is mandatory.

```
❌ **Nothing written for Round {round} yet.** The result *is* the feedback — the scores don't go to the dancer — so there's no message to read back until one of you has written something. Use the **Note** button on the card, or `/diamonds feedback`.
```

---

## Gone

- **M2**, the planned-start reminder, and `/diamonds plan` with it.
- **M3**, the ten-days-on-a-piece heads-up.
- **M13**, folded into M12 — every failure offers practice now.
- **M24b and M24c**, the Round 0 plan refusal and the plan invitation.
- **The last-chance nudge** and **the unopened-feedback nudge**, from earlier
  passes.

Numbering is unchanged across all of this so earlier references still work,
which is why there are gaps.
