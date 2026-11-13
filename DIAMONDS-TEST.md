# Testing the Diamonds audition privately

A path through the whole thing on your own account, before anyone else can
see it. Follow it in order — the ordering is the part that matters, and most
of the ways this goes wrong are ordering mistakes rather than bugs.

## The one rule

**Test before you run `/diamonds grant`, not after.**

The sweep walks every record under `dia:rec:` and acts on each one. While
your own test record is the only record, it has nothing else it could
touch. Once the existing Diamonds are on the list, it does.

**Right now the sweep cannot run at all**, which buys you the whole test
week for free: `.github/workflows/diamonds-daily.yml` exists only on this
machine. GitHub runs scheduled workflows from the default branch, and the
file has never been pushed, so there is no Diamonds cron on GitHub —
`trainee-daily.yml` is missing up there too. Nothing autonomous happens
until you push. The ordering above is still the right ordering, because
pushing is what starts the clock, and it is one command.

It is not as sharp as it sounds: `grantMembership` refuses a date in the
past, so a granted member can't lapse the next morning. What it *can* do
is send a renewal notice, which goes out 60 days before the enforcement
date (`diamonds_notice_first`). A real member getting a real "your
membership ends in 60 days" DM in the middle of your test week is the
exposure. Keep the list empty and there isn't one.

## Phase 0 — with the flag still off

`config` and `schedule` are the two subcommands that run while Diamonds is
switched off, because setting the calendar and reading it back are how you
decide whether to turn it on.

1. `/diamonds config` in #diamonds-bot. Read every line of it against what
   you actually intend. Anything marked `default` is a number nobody has
   set, not a number anybody agreed.
2. `/diamonds schedule opens:YYYY-MM-DD` if the open date is wrong.
3. `npm run doctor` — the `dancer access` warning is expected and correct
   right now. It is telling you the channel is admin-only, which is what
   you want this week.

## Phase 1 — make a solo run possible

`diamonds_min_scores` is **2**, so no round settles until two directors
have balloted. On your own that stalls every round at the first one. Drop
it to 1 for the test:

```bash
npx wrangler kv key put --binding=KV --preview false "config:diamonds_min_scores" "1"
```

Then turn Diamonds on:

```bash
npx wrangler kv key put --binding=KV --preview false "config:features.diamonds" "true"
```

Check it took, and that no records exist yet:

```bash
npx wrangler kv key list --binding=KV --preview false | grep -E "dia:rec:|features.diamonds"
```

**Put `min_scores` back to 2 before you open this up.** It is the whole
anti-anchoring design — one ballot settling a round means one director
deciding it. There's a reminder in Phase 6.

## Phase 2 — the newcomer run, end to end

Your cohort is read off your roles, so holding DIAMOND would register you
as *returning* — which owes no Round 0 cover and skips the most interesting
part. Force the newcomer path first:

1. `/diamonds add dancer:@you cohort:new`
   Puts you on the list as a newcomer and DMs you the panel. It does not
   record a cover, so you still owe one.

2. `/diamonds register cover:<any url>`
   Registering **is** the Round 0 submission. It records the cover and
   posts the review card to #audition-review. Check the card is there —
   that card going up on registration is the thing that merging the two
   commands nearly lost.

3. `/diamonds score dancer:@you verdict:pass`
   Or the buttons on the card. Round 0 is a verdict, not a number.

4. `/diamonds feedback dancer:@you` → write something real in the modal.
   **Round 0's result *is* the feedback**, so there is nothing to send
   without it. Testing with a one-word placeholder is fine; testing with
   nothing tells you nothing.

   ⚠️ **Round 0 sends itself.** Unlike the later rounds there is no
   preview and no Send button — the moment the verdict has settled, the
   feedback is written *and* Round 1's piece is up, it goes. Whichever of
   those three lands last is what sends it. So get the verdict right
   before you write the feedback, because writing it is the trigger.

5. `/diamonds assign dancer:@you piece:<link> target:<one specific thing> starting-score:<0-10>`
   The Round 0 pass is deliberately held until Round 1's piece exists, so
   the pass, the document and the start button arrive as one DM. Do this
   with steps 3 and 4 already done and *this* is the call that sends it;
   do it first and step 4 is. Before it exists, step 4 tells you it's
   holding.

6. Check your DMs. One message: the news, the whole document, one button.
   **Press it.** That reveals the piece and starts a 3-day window in the
   same action — there is no separate reveal, by design.

7. `/diamonds submit link:<url>`, or the submit button on the panel.

8. `/diamonds score dancer:@you target-score:<0-10>`
   Round 1 is judged on movement from the `starting-score` you fixed in
   step 5, against a target that scales — the lower the start, the more
   movement is wanted, capped at the bar. Score it *below* the target once
   to see the fail branch, then rescore above it. Rescoring overwrites your
   ballot rather than adding one, and the outcome is derived, so it follows
   — as long as you haven't sent the result yet.

9. `/diamonds feedback dancer:@you`, then `/diamonds result dancer:@you`.
   **From Round 1 on, nothing goes out on its own.** `result` gives you a
   preview with a Send button, and the result is the one thing here with no
   undo. It refuses to send with no feedback written, because with the
   scores kept back the feedback is the entire message.

10. `/diamonds assign-all round:2 piece:<link>` — Round 2's group piece.
    Same start button, same reveal-on-start.

11. Submit, then `/diamonds score dancer:@you technicality:<n> execution:<n>
    performance:<n> musicality:<n>`. Weighted 40/30/20/10 against the bar
    at 7.5, with a floor of 6 on any single dimension.

12. `/diamonds feedback`, `/diamonds result`. **On a pass the DIAMOND role
    goes on** and the membership date is recorded. Check the role actually
    appeared — that is the one step with an effect outside the bot.

`/diamonds roster` at any point shows who's where and what's waiting on
you. `/diamonds status` is the same question from the dancer's side.

## Phase 3 — the branches worth a look

Each of these needs a fresh record, so see Phase 5 for the reset.

- **Practice from the door.** `/diamonds register cover:<url> practice:true`
  — all three rounds, same feedback, no verdict, nothing recorded.
- **Practice as a landing.** Fail Round 1 (step 8 above), then press
  Practice on the result. Round 2 becomes practice too.
- **An extension.** Press Ask on your panel, give days and a reason. A card
  with Grant and Deny appears in #audition-review. Deny needs a note — "no"
  on its own just invites asking again.
- **Withdrawing and coming back.** `/diamonds withdraw`, then
  `/diamonds register` again. A withdrawal resumes where you left off; it
  does not reset you.
- **The retry wait.** Fail Round 2, then try to register again. It should
  refuse with a 6-month date and point you at a director.
- **DMs closed.** Turn off DMs from server members in the dance server's
  privacy settings, then trigger anything that DMs you. It should alert
  #directors-bot-confirmation and name the setting.

## Phase 4 — the sweep

**This needs the workflow pushed first** — see the rule at the top. Once it
is on `main`, don't wait for 08:40 ET: GitHub → Actions → `diamonds-daily`
→ **Run workflow**. The `workflow_dispatch` trigger is there for exactly
this. (`gh` isn't installed on this machine, so the Actions tab is the way.)

It needs no new secrets. It reads `WORKER_URL` and `INBOUND_SECRET`, the
same two `applications-daily` already uses — so if that one is green in the
Actions tab, this one will run too. Worth a glance at its last run before
you rely on that.

What it should do: remind you the day before a window shuts, nudge you as
the last start date approaches, warn then close the 60-day run, and post a
daily list of anything that has been sitting un-balloted longer than 5
days. What it should **not** do is touch your membership — you and Huy hold
Diamond Director, which is exempt from both the lapse and the renewal
notices. That exemption is also why the renewal ladder is the one thing you
cannot test on yourselves; it needs a third record with a near date.

The two yearly reminders are on this same endpoint. The group-piece one is
next due **15 December**. You can't easily fake the date, so trust the
tests for those.

## Phase 5 — reset between runs

Find and delete your record:

```bash
npx wrangler kv key list --binding=KV --preview false | grep "dia:rec:"
```

```bash
npx wrangler kv key delete --binding=KV --preview false "dia:rec:<your-discord-id>"
```

Records carry a 600-day TTL, so nothing expires on its own inside a test
week. If you passed a round, take the DIAMOND role back off by hand — the
bot added it and deleting the record will not undo that.

## Phase 6 — before anyone else sees it

In this order:

1. **`diamonds_min_scores` back to 2.**

```bash
npx wrangler kv key put --binding=KV --preview false "config:diamonds_min_scores" "2"
```

2. **Delete every test record** (Phase 5), and take off any role the test
   handed you.
3. **Open #diamonds-bot to the auditionees.** Channel → Permissions → allow
   View Channel for the role they hold, the way #trainee-bot re-grants RISK
   Member. Not the Diamonds role alone: that is what passing earns, so
   granting only it shuts out every newcomer. `npm run doctor` stops warning
   once this is done.
4. **`/diamonds grant`** for each existing Diamond, with the date they must
   re-audition by. Leave `until` blank to derive it from today.
5. **`/diamonds config`** once more, read against the announcement you
   wrote.
6. **Push, so the cron exists.** `git pull --rebase` first — `origin/main`
   has a keepalive commit this checkout doesn't, so a plain push is
   rejected. This is also what puts `trainee-daily.yml` up there, and it is
   the step that makes everything above start happening on its own.
7. **`npm run deploy`**, if the Worker hasn't been deployed since these
   commits. The cron calls the Worker; pushing the workflow doesn't update
   the code it calls.
8. Calibrate with Huy against the reference deck, so the first real ballots
   mean the same thing from both of you.

The flag is already on from Phase 1. If you turned it off at any point:

```bash
npx wrangler kv key put --binding=KV --preview false "config:features.diamonds" "true"
```
