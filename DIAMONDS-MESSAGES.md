# Every message, as text you can edit

**How to use this.** Change the words inside the code blocks. Leave the
`{tokens}` alone — they're filled in at send time, and renaming one breaks it.
When you're done, tell me and I'll put the new wording into the code.

Each one says when it fires and who sees it. `\n` isn't needed: a blank line in
the block is a blank line in Discord.

**Tokens used below**

| Token | Becomes |
| --- | --- |
| `{round}` | 0, 1 or 2 |
| `{dancer}` | a mention, or their display name on a card |
| `{days}` `{left}` | a number of days |
| `{window}` | 3 — the days in a window |
| `{run}` | 60 — the days for all three rounds |
| `{review}` | 1–5 — the turnaround range |
| `{needed}` | 16 — the process end to end |
| `{date}` `{closes}` `{ends}` | a date Discord renders in the reader's own timezone |
| `{note}` `{reason}` | something a director or dancer wrote |

Panels aren't in here — they're assembled from parts and change with state. Ask
and I'll pull those out too.

---

## To a dancer, on its own schedule

The daily sweep. **At most one per person per day**, first match wins.

### M1 · Their open window shuts tomorrow

```
⏰ **Round {round} closes {closes}.** Submit with `/diamonds submit link:<url>` before then. If something's gone wrong, you can request for an extension.
```

### M2 · ~~The day they said they'd start~~ — removed

Gone from the code. `/diamonds plan` still records the date and `/diamonds
roster` still shows it to the directors, so the estimate keeps the one job it
was best at; it just doesn't DM anybody about it any more.

### M3 · A piece has sat unstarted for 10 days

```
👋 **Round {round}: your piece has been waiting {days} days.** No rush, just keep in mind you only have 60 days — the {window} days run from whenever you start.
`/diamonds start` when you want it.

Worth knowing: starting is what shows you the piece, so there's nothing to look at beforehand and nothing to gain by waiting — everyone gets the same {window} days with it.
```

*(The last paragraph only appears for rounds where the piece is hidden until
start, which is 1 and 2.)*

### M4 · On the list 10 days with no cover

Only reachable through `/diamonds add` — registering is sending the cover.

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

Three rungs, each once, most urgent only. Silent while a re-audition is live.

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

**M8d — replaces all three** when their six-month wait outruns their date. Never
tells them to re-audition, because they can't.

```
⚠️ **Your Diamonds membership runs to {date}, and you can't re-audition before {until}.**

That's the wait after dropping out, and it runs past your renewal — so on current rules the role comes off on {date}. **Talk to a director.** They can put you back on the list inside the wait, and they would rather do that than lose you to a calendar.
```

## To a dancer, because a director did something

### M9 · Round 0 passed

Held until the feedback is written *and* the Round 1 piece is up, so this is one
message with the Start button on it.

```
💎 **Round 0: you're through to Round 1.** Nicely done.

{document}

**Your Round 1 piece is ready when you are.**
{start warning}

No hurry: read the above properly first, and press it when you've got {window} days you're happy to spend.
```

`{start warning}` is M9a, shared with every start button:

```
Pressing this shows you your piece **and starts your clock at the same time.** From that moment you have {window} days to learn it, record it and submit. There's no way to un-press it.
```

`{document}` is M9b, the feedback itself:

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

The `{document}` here ends differently (M10a):

```
**We're not taking this one through to Round 1.** That's our call on what we saw here, not a verdict on you as a dancer — and everything above is honest and worth having either way. Come back at us next cycle; we'd like you to.
```

### M11 · Round 1 result — advanced

```
**Diamonds {year} — Round 1**

🎉 **You're through to Round 2.**

**{target}:** {before} before, **{after}** now.

That's real movement on the thing we named, which is exactly what this round was asking for.

Your final piece will arrive here. Everyone dances the same one, you get it privately when you start, and you'll have {window} days.
```

*(Someone who was already at the bar and held it gets "You were already strong
there and held it, which counts." instead of the "real movement" line.)*

### M12 · Round 1 result — not advanced

```
**Diamonds {year} — Round 1**

🚫 **Not through to Round 2 this time.**

**{target}:** {before} before, **{after}** now.

That's the one thing this round measured, and it didn't move enough to carry you forward. It isn't a verdict on you as a dancer and it isn't the end of anything — keep working on it, and audition again. We'd rather you did.
```

### M13 · Round 1 result — carried on as practice

```
**Diamonds {year} — Round 1**

🚫 **That didn't move enough to carry you into Round 2 for real.**

**{target}:** {before} before, **{after}** now.

**We'd like you to do Round 2 anyway, as practice.** Same piece as everyone, same {window} days, same written feedback — and no pass or fail at the end of it, because this run is already decided. Nothing is recorded against you and nothing stops you auditioning again.

Your piece will arrive here. If you'd rather stop, that's completely fine — tell a director.
```

### M14 · Round 2 result — passed

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

### M15 · Round 2 result — failed

```
**Diamonds {year} — Round 2**

🚫 **Not this cycle.**

{the four scores}
```

### M16 · Any practice round's result

```
**Diamonds {year} — Round {round}, practice**

📝 **Here's what we saw.** This one was practice, so there's no pass or fail in it and nothing rides on the numbers — they're there because a read you can't see isn't feedback.

{the scores, or the one target number}

Your next piece will arrive here the same way.
```

*(After Round 2 the last line becomes: "That's the end of the run. Nothing is
recorded against you, and you can audition for real whenever you want to.")*

### M17 · A piece goes up

The round panel, as a DM. Its "ready to start" state:

```
**Round {round} · Diamonds {year}**
🎬 **Your piece is ready.** Nobody needs to be here for this — start whenever you're ready to give it {window} days.

{start warning}

**No deadline on starting the window itself** — the piece keeps until you want it.
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

## To a dancer, answering them

### M21 · After **Ask for more time**

```
⏳ **Asked.** The directors have it, and they'll answer either way. **Your deadline is still running** until they do, so keep working if you can — a granted extension on a submitted round is a much better problem than the other way round.
```

### M22 · After **Dance the rest as practice**

```
📝 **You're down for Rounds 1 and 2 as practice.** Round 0's result doesn't change, and nothing from here is judged.
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

## To the directors

### M25 · A dancer asks for days — in #audition-review

```
⏳ **{dancer} is asking for {days} more days** on their Round {round} window ({window} days).
> {reason}

Their deadline is still running while this sits here, so it's worth answering today either way. A denial needs a reason — they'll be told what you write.
```

Once answered it becomes (M25a):

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
