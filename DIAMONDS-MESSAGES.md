# Every message, as text you can edit

Current as of the consistency pass. **M1 and M3 are your wording** — they're in
the code now. Numbers are unchanged from the last version so your references
still work, which is why there's no M2: it was removed rather than renumbered.

**How to use this.** Change the words inside the code blocks. Leave the
`{tokens}` alone — they're filled in at send time, and renaming one breaks it.
When you're done, tell me and I'll put the new wording into the code.

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
| `{months}` | 6 — the retry wait |
| `{date}` `{closes}` `{ends}` `{until}` | a date Discord renders in the reader's own timezone |
| `{note}` `{reason}` | something a director or dancer wrote |

A blank line in a block is a blank line in Discord.

---

## To a dancer, on its own schedule

The daily sweep. **One per person per morning**, first match wins.

### M1 · Their open window shuts tomorrow

```
⏰ **Round {round} closes {closes}.** Submit with `/diamonds submit link:<url>` before then. If something's gone wrong, you can request for an extension.
```

### M2 · removed

The "you said you'd start today" reminder — and then `/diamonds plan` with it.
The reminders across the 60 days cover what it was for, and the roster now shows
each person's **days left** where their guessed date used to be, which is the
thing you actually wanted from it.

### M3 · A piece has sat unstarted for 10 days

```
👋 **Round {round}: your piece has been waiting {days} days.** No rush, just keep in mind you only have {run} days — the {window} days run from whenever you start.
`/diamonds start` when you want it.

Worth knowing: starting is what shows you the piece, so there's nothing to look at beforehand and nothing to gain by waiting — everyone gets the same {window} days with it.
```

*(Last paragraph only for rounds where the piece is hidden until start — 1 and 2.)*

### M4 · On the list 10 days with no cover

Only reachable through `/diamonds add`, since registering is sending the cover.

```
👋 **You're on the Diamonds list, and we haven't got a cover from you yet.** A director put you on rather than you registering, so this may be news: Round 0 is a video of your own choosing, and an existing one from the last six months is fine.
`/diamonds submit link:<url>` whenever you like.
```

### M5 · Ten days left of their 60

```
⏳ **{left} days left on your audition.** All three rounds have to be done by {ends} — that's the {run} days from when you registered.
There's still room: a round takes {window} days and we turn feedback round in {review}.
If that isn't enough, say so to a director **before** the date rather than after. They can put you back on afterwards, but it's a worse conversation than this one.
```

### M6 · The 60 ran out with rounds unfinished

```
⌛ **Your audition has closed.** The {run} days you had to get through all three rounds are up.

This isn't a judgement on your dancing — it's a clock, and it exists so a Round 1 read and a Round 2 months later aren't being compared as if they were the same week. **If something got in the way, tell a director:** they can put you straight back on the list, and that's much easier than it sounds.
```

### M7 · Membership date passed with no re-audition

Sent *after* the role has already come off.

```
💎 **Your Diamonds membership has ended.** It ran to {date}, and a re-audition is what renews it — so the role has come off.

This isn't a judgement on your dancing and it isn't a door closing: register again whenever you want and you go through the rounds like anyone else. If you think this is wrong, or something got in the way, tell a director — they can put it right.
```

### M8 · The renewal ladder

Each rung once, most urgent only, silent while a re-audition is live.

**M8a — 60 days out**

```
💎 **Your Diamonds membership runs to {date}** — about two months off.
Re-auditioning before then renews it, and going early is worth more: your next date is set by the half of the year you re-audition in, so the sooner you go the longer the next term. Nothing to do today beyond knowing the date.
```

**M8b — 30 days out**

```
💎 **A month to {date}**, when your Diamonds membership is up for renewal.
A re-audition needs about {needed} days end to end — the rounds, the windows and our turnaround — so this is the point to pick the week you'll start rather than the day. `/diamonds status` has where you stand.
```

**M8c — 20 days out**

```
⚠️ **{left} days to {date}.** That's about as long as a re-audition takes, so if you want to renew this term it needs to start now.

If you haven't re-auditioned by {date} you come off the Diamonds role — not a judgement, just how membership works, and you're welcome back at the next audition. If something's in the way, tell a director rather than letting the date pass: they can move it.
```

**M8d — replaces all three** when their six-month wait outruns their date.

```
⚠️ **Your Diamonds membership runs to {date}, and you can't re-audition before {until}.**

That's the wait after dropping out, and it runs past your renewal — so on current rules the role comes off on {date}. **Talk to a director.** They can put you back on the list inside the wait, and they would rather do that than lose you to a calendar.
```

## To a dancer, because a director did something

### M9 · Round 0 passed

Held until the feedback is written **and** the Round 1 piece is up, so it's one
message with the real Start button on it.

```
💎 **Round 0: you're through to Round 1.** Nicely done.

{document}

**Your Round 1 piece is ready when you are.**
{start warning}

No hurry: read the above properly first, and press it when you've got {window} days you're happy to spend.
```

**M9a — `{start warning}`**, shared with every start button, so editing it
changes the warning everywhere:

```
Pressing this shows you your piece **and starts your clock at the same time.** From that moment you have {window} days to learn it, record it and submit. There's no way to un-press it.
```

**M9b — `{document}`**, the written feedback:

```
**Your Diamonds feedback**

{what the directors wrote}

**What you brought**
· {strength}
· {strength}
· {strength}

**Where to grow**
· {growth area}

**You're through to Round 1.** We'll send you a piece picked to test one specific thing, and we'll tell you what that thing is and where we have it today. You'll get {window} days with the piece to show movement on it — everything else still counts, but that one thing is what the round turns on.

Start it yourself whenever you're ready: the clock doesn't run until you press the button, so take as long as you like getting there.
```

### M10 · Round 0 failed

Everything at once, no button in front of it, plus the practice offer.

```
**Round 0: we're not taking this one through to Round 1.** That's our call on what we saw, not a verdict on you as a dancer.

{document}

**If you'd like to dance the rest of it anyway, you can.** Rounds 1 and 2 as practice: the same pieces, the same {window}-day windows, the same written feedback from both of us — and no verdict at the end, because this one is already decided. It costs you nothing and it doesn't change this result either way.
```

**M10a — the document ends differently on a fail:**

```
**We're not taking this one through to Round 1.** That's our call on what we saw here, not a verdict on you as a dancer — and everything above is honest and worth having either way. Come back at us next cycle; we'd like you to.
```

### M11 · Round 1 — advanced

```
**Diamonds {year} — Round 1**

🎉 **You're through to Round 2.**

**{target}:** {before} before, **{after}** now.

That's real movement on the thing we named, which is exactly what this round was asking for.

Your final piece will arrive here. Everyone dances the same one, you get it privately when you start, and you'll have {window} days.
```

*(Someone already at the bar who held it gets "You were already strong there and
held it, which counts." instead of the "real movement" line.)*

### M12 · Round 1 — not advanced

```
**Diamonds {year} — Round 1**

🚫 **Not through to Round 2 this time.**

**{target}:** {before} before, **{after}** now.

That's the one thing this round measured, and it didn't move enough to carry you forward. It isn't a verdict on you as a dancer and it isn't the end of anything — keep working on it, and audition again. We'd rather you did.
```

### M13 · Round 1 — carried on as practice

```
**Diamonds {year} — Round 1**

🚫 **That didn't move enough to carry you into Round 2 for real.**

**{target}:** {before} before, **{after}** now.

**We'd like you to do Round 2 anyway, as practice.** Same piece as everyone, same {window} days, same written feedback — and no pass or fail at the end of it, because this run is already decided. Nothing is recorded against you and nothing stops you auditioning again.

Your piece will arrive here. If you'd rather stop, that's completely fine — tell a director.
```

### M14 · Round 2 — passed

```
**Diamonds {year} — Round 2**

🎉 **You've passed.** Welcome to Diamonds.

· Technicality — **{score}**
· Execution — **{score}**
· Performance — **{score}**
· Musicality — **{score}**
Weighted: **{weighted}**

**Your membership runs to {date}.** Diamonds is re-auditioned rather than permanent — re-audition before then and it renews, and going early in the half is worth a longer next term.
```

### M15 · Round 2 — failed

```
**Diamonds {year} — Round 2**

🚫 **Not this cycle.**

{the four scores}
```

### M16 · Any practice round

```
**Diamonds {year} — Round {round}, practice**

📝 **Here's what we saw.** This one was practice, so there's no pass or fail in it and nothing rides on the numbers — they're there because a read you can't see isn't feedback.

{the scores, or the one target number}

Your next piece will arrive here the same way.
```

*(After Round 2: "That's the end of the run. Nothing is recorded against you,
and you can audition for real whenever you want to.")*

### M17 · A piece goes up

The round panel as a DM, in its ready-to-start state:

```
**Round {round} · Diamonds {year}**
🎬 **Your piece is ready.** Nobody needs to be here for this — start whenever you're ready to give it {window} days.

{start warning}

**No deadline on starting the window itself** — the piece keeps until you want it.
```

Plus **M17a**, the line underneath on every panel where the next move is theirs:

```
⏳ **All three rounds by {ends}** — {run} days from when you registered, and **{left}** left. The whole thing takes about {needed} days of actual process, so there's room; if you need more, ask a director before the date rather than after.
```

And **M17b**, which replaces it once the clock has gone:

```
⌛ **Your {run} days ran out {ends}.** Talk to a director — they can put you back on the list with a fresh {run} days.
```

### M18 · An extension granted

```
⏳ **Extension granted** — Round {round} now closes {closes}. {days} extra days.
```

### M19 · An extension denied

```
🚫 **We can't give you the extra time on this one** — your deadline stands as it was.
> {note}

If that lands badly or something has changed, say so to a director rather than letting the date pass.
```

### M20 · `/diamonds grant`

```
💎 **Your Diamonds membership is on the books until {date}.**

Diamonds is re-auditioned rather than permanent — re-audition before then and it renews, and going early in the half is worth a longer next term. You'll get reminders well ahead of the date; there's nothing to do now.
```

### M21 · `/diamonds add` — somebody a director put on who owes a cover

The Round 0 panel. **No plan button on it any more**: registering is the cover,
so there's nothing left to schedule.

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

**If you just need more time, you don't need this.** There's an **Ask for more time** button on your panel while a window is open, and a director can move the whole thing if it's bigger than that. Either is far easier than undoing this — talk to one of them first.
```

### M24 · After confirming a withdrawal

```
You're off the list, and the wait has started. A director can put you back on inside it if your case warrants it — ask them rather than waiting it out in silence.
```

### M24a · After **Dance the rest as practice**

```
📝 **You're down for Rounds 1 and 2 as practice.** Round 0's result doesn't change, and nothing from here is judged.
```

### M24b, M24c · removed

The Round 0 plan refusal and the plan invitation, both gone with
`/diamonds plan`.

## To the directors

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

### M26 · Somebody's 60 days ran out

```
⌛ **{dancer}'s audition has closed** — {run} days up with the rounds unfinished.
`/diamonds add` puts them back on if you want to.
```

### M27 · Somebody came off the Diamonds role

```
💎 **{dancer} has come off Diamonds** — their membership ran out today with no re-audition.
```

### M28 · Ballots owed past the promised turnaround

The only message that repeats — daily until the list empties.

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

---

## Gone since the last version

- **M2**, the planned-start reminder.
- **The last-chance nudge** — it counted back from the close date, which no
  longer exists.
- **The unopened-feedback nudge** — there's no button between the pass and the
  piece any more, so there's nothing to leave unopened.
