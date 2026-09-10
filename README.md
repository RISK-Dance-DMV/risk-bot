# RISK bot

Cloudflare Worker + Apps Script. Currently implements **rank 6 — draft → approve
→ publish**, **rank 21 — form registration**, **rank 22 — application intake**,
**rank 23 — decision**, **rank 24 — interview** and **rank 27 — email** from
design doc v11, plus the slice of rank 0a they need.

## What's here

| Piece | File |
| --- | --- |
| Column addressing + header verification | `src/applications/fields.ts` |
| Video link extraction + share-access check | `src/applications/videos.ts` |
| Sheet deep links | `src/applications/sheetLink.ts` |
| Card rendering (dancer card / one-liner) | `src/applications/card.ts` |
| Intake orchestration + card state | `src/applications/intake.ts` |
| Daily backstop | `src/applications/backstop.ts` |
| 14-day stale-card sweep | `src/applications/stale.ts` |
| Audition submissions → card updates | `src/applications/auditions.ts` |
| Votes, final outcome, feedback | `src/applications/decision.ts` · `vote.ts` |
| `/form register` | `src/commands/formRegister.ts` |
| Command gating (three layers) | `src/commands/gate.ts` |
| Draft → approve → publish | `src/drafts/draft.ts` · `service.ts` |
| Interviews | `src/applications/interview.ts` · `interviewSlot.ts` |
| Email templates + sending | `src/email/templates.ts` · `service.ts` |
| Audit trail | `src/audit.ts` |
| Worker routes | `src/index.ts` |
| Discord REST, Ed25519 verify | `src/discord/` |
| Form trigger + sheet reads | `apps-script/Code.gs` |

**Deliberately not built:** rank 25 (digests), so nothing chases an interview
stuck at `offered`. Capacity-based waitlisting — the waitlist button exists, the
"we're full" logic doesn't. Also not built, despite appearing in §27's endpoint
list: `readDirectory` / `writeDirectory` (rank 2/3); that list is the Apps Script
surface inventory, not rank 27's work — `registerForm` came from it at rank 21 for
the same reason. No `/form status` — the register command prints the resulting
config, and reading it back later isn't wired. No autocomplete, no `/features`, no
Sheets data seam — the flag registry reads KV (`src/config/flags.ts`).

## Audition methods

Column **AL** ("Chosen audition method") splits the flow:

| Answer | Card state | Behaviour |
| --- | --- | --- |
| Existing dance video submission and interview | `open` | Reviewable on arrival. No videos in AM–AP is flagged as a problem. |
| RISK Audition process | `awaiting` | Waits on the separate audition form. No videos is expected, not flagged. Shows a closing date. |
| anything else / blank | `open` | Classified `unknown`, flagged on the card with the raw answer shown. Never guessed at. |

An `awaiting` card with no audition submission after
`config:application_audition_days` (default 14) is **closed** by the daily sweep:
the message edits in place to a visible closed state and gains a **[Reopen]**
button, which restarts the clock. This is the one auto-transition in intake —
doc §25 says nothing auto-lapses, so it was kept reversible deliberately.

**How a submission gets back to the card.** The audition form's `onFormSubmit`
notifies the Worker, which matches the submission to an application **by email** —
the audition form's email column is resolved once at registration and stored, not
re-guessed on every read. A match flips `awaiting` → `submitted`. A submission
that arrives after the card already closed reopens it as `submitted`, since the
audition did happen, just late.

A submission that matches no application, carries no email, or matches someone who
chose the video-submission route is reported to #directors-bot-confirmation once —
never silently dropped, because the visible consequence would be their card
closing on schedule.

## Rank 24 — interview

```
[Interview] → modal → draft → [Approve] sends it → interview-offered
           → they reply → [Interview Confirmed] → calendar invite → interview-scheduled
```

`interview-offered` means **we told them** — the draft-to-schedule email was
sent. The status advances only when the invitation actually goes out through
rank 6 + 27, never when it's merely written.

**There's a third state the doc doesn't list: `drafted`.** It's the gap between
writing an invitation and it going out, named for what has happened rather than
what's intended. Without it, an offer nobody approved looks identical to one that
was sent — the exact failure §24's gate exists to prevent.

| Card shows | Means |
| --- | --- |
| Interview **drafted** | ⚠️ not offered yet — approve the draft to send it |
| Interview **offered** | invitation emailed, waiting on their reply |
| Interview **scheduled** | calendar invite sent |

**The modal uses all five components** — availability (prefilled from column AQ,
reference only), date, start time, minutes, and an optional note. Date and time
are **separate explicit fields**, not the free text the doc implies, because a
calendar event can't be built from "sometime Saturday afternoon". The note is
appended to the rendered template rather than merged, so a template without a
`{{note}}` field still works and a blank note doesn't count as unfilled.

**Timezones are Apps Script's problem.** The Worker passes the literal date and
time the director typed; Apps Script builds the event in the calendar's own
timezone rather than converting twice. Optional `INTERVIEW_CALENDAR_ID` script
property, defaulting to the RISK account's own calendar.

**`[Interview Confirmed]` opens its own modal**, prefilled with the time you
offered — because the time they actually agree to often isn't it. Confirming an
unchanged time is three taps; changing it records `moved from …` on the card and
builds the event at the new time.

**`[Interview]` only appears after a unanimous yes.** The vote decides whether to
interview; a rejected or still-undecided card offers nothing, and the button
disappears once an outcome is recorded.

**Both steps are gated on `email_sends`** — the invitation is an email, and the
calendar invite emails them too. With the flag off, `[Interview Confirmed]`
records nothing and says so; the status stays `interview-offered`.

Redrafting is allowed at any point before it's scheduled — the button relabels to
*Redraft interview*. The superseded draft stays pending in #audition-review; skip
it by hand.

## Rank 27 — email

**The only truly irreversible action in the system.** Off by default and gated
twice: `features.email_sends`, and a human clicking `[Approve]` on a draft
showing the exact text.

Templates are sheet rows — `template_key | subject | body | notes` — with merge
fields written `{{name}}`. Point Apps Script at them:

| Script property | |
| --- | --- |
| `TEMPLATES_SHEET_ID` | spreadsheet holding the templates |
| `TEMPLATES_SHEET_NAME` | tab name, defaults to `Templates` |

Sending goes through **rank 6**, with an email target instead of a channel:

```ts
const rendered = await renderForSend(env, "interview invitation", { name, slot });
if (!rendered.ok) return rendered.reason;

await createDraft(env, {
  kind: "interview invitation",
  content: rendered.body,
  target: { kind: "email", to: applicantEmail, subject: rendered.subject },
  confirmation: { guild: "community", channel: "audition-review" },
});
```

Same three buttons, same click gate. `[Edit]` edits the **body**; the subject
comes from the template, so changing it means editing the template.

**Rendering happens in the Worker, not Apps Script.** The doc names one
`sendTemplated` endpoint; this splits it into `readTemplates` + `sendEmail`,
because `[Edit]` requires the rendered text to exist *before* the send and to be
changeable. A director eyeballing a template that Apps Script would render later
isn't eyeballing the message.

**An unfilled merge field refuses the whole draft.** A template rendering to
`Hi {{name}}` would otherwise go to a real applicant looking exactly like that,
once. It fails before the draft exists, naming the field.

Consumer Gmail allows **100 recipients/day**. Every send returns the remaining
quota, and the bot warns in #directors-bot-confirmation at 10 left — while
there's still room to finish a round. Send failures post there too.

With the flag off, `[Approve]` on an email draft declines and the draft stays
pending. That's the intended shape: create drafts, eyeball them for a cycle, then
turn it on.

## Rank 6 — draft → approve → publish

Every message intended for humans goes through this. **No feature flag** — a
draft that couldn't be created would mean the feature above it fails silently,
which is the opposite of the point.

```ts
await createDraft(env, {
  kind: "cycle announcement",
  content: "JUN–JUL starts Saturday.",
  target: { guild: "dance", channel: "announcements" },
  confirmation: { guild: "dance", channel: "coaches-bot-confirmation" },
  referencesAt: "2026-09-12T00:00:00Z", // optional; drives the 48h re-ping
});
```

The draft posts to the confirmation channel with three buttons:

| Button | Effect |
| --- | --- |
| `[Approve]` | publishes verbatim |
| `[Edit]` | modal prefilled with the draft, publishes the edited text |
| `[Skip]` | logged, publishes nothing |

Once actioned the draft message repaints with the outcome, the buttons go, and
approved drafts link to what was published. Every click is recorded with who made
it. `custom_id`s are persistent, so a draft still works long after the 15-minute
interaction token has expired.

A draft still unactioned **48h before the date it references** re-pings its
confirmation channel — once, not daily. `config:draft_reping_hours` (default 48);
the sweep runs from `.github/workflows/drafts-sweep.yml`.

Two things to know:

- **Discord channels only.** Publishing an *email* through the same
  draft-and-click gate is rank 27, and isn't built. Rank 24's interview
  invitation needs that, so rank 24 still can't ship complete.
- **Audit goes to KV, not the Audit Log sheet.** Writing that sheet needs the
  service-account client that doesn't exist yet. Everything is behind `audit()`,
  so it's one function to redirect.
- **Double-click race.** A draft is taken out of `pending` before anything is
  published, so a second click is declined. KV is eventually consistent, so two
  clicks in the same instant can still both win. Small window, real one.

## Rank 23 — decision

`[Yes] [No] [Need to discuss] [Leave feedback]`. Every click is recorded with who
made it, and the tally shows on the card. A hold is not a vote — it blocks
settlement without counting toward either side.

**When the buttons appear** depends on whether there is anything to decide on:

| Card state | Buttons |
| --- | --- |
| `awaiting` (RISK process, nothing submitted) | Hidden. The card says voting opens when the audition arrives. |
| `submitted` (RISK process, audition in) | Live |
| `open` (existing links) | Live from the first post |
| `closed` | Hidden |

**A split vote** locks Yes/No/Discuss, mentions the directors in a *separate*
message (editing the card would notify nobody), and puts **[Final Yes] / [Final
No]** on it. The conversation happens wherever it happens; one director records
the result, and it's attributed to them on the card. Both buttons stay visible
afterwards, so pressing the other one corrects a misclick — there's no undo to
find.

**Unanimous** means every director has voted the same way, at least
`config:decision_min_votes` (default 2) of them, with no hold outstanding —
doc §11's open question 3 answered with its own suggested default.

### The terminal step

`[WELCOME TO RISK]` `[Reject from RISK]` `[Waitlist]`. Each one drafts the
matching §27 email and records the outcome; nothing is sent until someone
approves that draft, so the card reads *"acceptance drafted, not sent yet"* until
it actually goes.

Reachable **two ways**, which is doc open question 3 (*"does direct acceptance
into Hearts/Spades still exist?"*) answered **yes**:

- straight after a unanimous vote, skipping the interview
- after an interview has been scheduled

A unanimous **no** offers only Reject and Waitlist — no welcome button to
mis-tap. All three stay visible after one is chosen, so a wrong click is
corrected by pressing another.

Which rejection template gets used depends on **column P**: a clear *yes* gets
`rejection with feedback`, anything else gets `rejection without feedback`. The
quieter template is the safer one to pick wrongly.

**Waitlist is a button, not a queue.** Capacity-based waitlisting — auto-flagging
when the roster is full — needs a number that doesn't exist yet and belongs with
rank 1's roster counts.

**Feedback** is a modal, stored per director and **hidden until every director has
written theirs**, so nobody is anchored by what came before. Submitting an empty
box withdraws yours. Until then the card shows only `2 of 3 in`.

Directors are an explicit list, not a role:

```bash
npx wrangler kv key put --binding=KV config:director_ids "111,222,333" --remote
```

Doc §2 rules out privileged intents, and enumerating a role's members over REST
needs `GUILD_MEMBERS` — so "all directors have submitted" has no denominator
without a stated roster. An explicit ID list is also a stricter check than a role,
never a permission bit standing in for "director". With it unset, the buttons
decline and say so rather than silently accepting votes that can never settle.

## The two forms

They're separate forms, and they're wired up differently on purpose.

**The application form** is addressed by its response sheet URL, not registered.
It doesn't rotate, so opening the form, proving RISK owns it and tracking its
history buys nothing. Set the `APPLICATION_SHEET_URL` script property to the
sheet link **with the responses tab selected** — the tab is picked by the `gid` in
that URL — then run `installApplicationTrigger()` once from the Apps Script
editor. It prints the tab it found and the C/D/E headers so you can eyeball them
there rather than discovering a mismatch on the first real applicant.

**The audition form** rotates twice a year (doc §26), so it goes through
registration:

```
/form register type:audition url:<audition form url>
```

Directors only, in #directors-bot-confirmation. Gated three ways per doc §2:
`default_member_permissions: 0` hides it, hand-added overrides in Server Settings
→ Integrations grant it, and **the handler's role check is the real gate** — no
permission bit is used as a proxy for "director".

Registration inspects before it commits, so a refusal writes nothing and installs
no trigger. It refuses when:

- the form wasn't created by the RISK account (a trigger can't be installed on a
  form RISK doesn't own — the owner's address is named in the refusal)
- the form has no linked response spreadsheet
- no column looks like an email, so submissions could never be matched to an
  application

On success it installs the trigger, records the previous form's ID and the dates
it was live, and writes the new config.

Both triggers guard on the **sheet id**, not the tab name, so renaming a tab
doesn't silently stop intake.

## Before this can run

1. **Fill in `src/config/columns.ts`.** C/D/E are pinned by the doc, AL and AM–AP
   are set. Every other card field is `column: null` and renders as `—` with a
   warning on the card until you set its letter. `PINNED_HEADER_MATCH` holds
   plausible guesses, not verified values — check them against the live form.

## Setup

The response sheet URL is in `wrangler.toml` under `[vars]`, not a secret —
Google controls access by sharing, and the gid is read from it so cards deep-link
to the right tab. Paste the link with the **responses tab selected**; a link
copied from a different tab sends every card's [Sheet row] button to the wrong
place at the right row number.

**Cloudflare**

```bash
npx wrangler kv namespace create KV
```

Put the returned ids in `wrangler.toml`, then set secrets:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put GUILD_COMMUNITY_ID
npx wrangler secret put GUILD_DANCE_ID
npx wrangler secret put APPS_SCRIPT_URL
npx wrangler secret put APPS_SCRIPT_SECRET
npx wrangler secret put INBOUND_SECRET
```

Set the Discord app's Interactions Endpoint URL to `https://<worker>/interactions`.

**Discord commands**

```bash
npm run register
```

Then grant directors access in Server Settings → Integrations → RISK bot. Those
overrides hang off the command's ID, so the script uses POST (which upserts by
name and keeps the ID) rather than a bulk overwrite.

**Apps Script** — paste `apps-script/Code.gs` into a script owned by the RISK
account. Set script properties `APPS_SCRIPT_SECRET`, `INBOUND_SECRET`,
`WORKER_URL`, `APPLICATION_SHEET_URL`. Deploy as a web app: **Execute as me**,
**Anyone**. Don't set the `forms.*` properties by hand — `/form register` writes
those.

**Wire up the two forms.** Nothing reads a sheet until both are done:

```
run installApplicationTrigger() once from the Apps Script editor
/form register type:audition url:<audition form url>
```

`APPLICATION_SHEET_URL` appears twice on purpose — in Apps Script it's the data
source, in `wrangler.toml` it's what the `[Sheet row]` buttons link to. Same URL,
two jobs.

**GitHub Actions** — repo secrets `WORKER_URL` and `INBOUND_SECRET`.

**Turn it on** (off by default):

```bash
npx wrangler kv key put --binding=KV config:features.applications true --remote
```

## Notes on choices

- **No `googleapis`.** It's Node-only and doesn't run on Workers. The sheet is
  read through Apps Script, which also keeps applicant email and personal data
  behind the RISK account rather than a service account.
- **The notifier sends only a row number.** No applicant data in the webhook body.
- **`[Open row]` defers first.** The 3s interaction budget won't cover an Apps
  Script round trip. The `custom_id` carries the row, so it still works after the
  15-minute token expires.
- **Channel names, never IDs.** Resolved at use, cached in KV, re-resolved on 404.
- **Link checks are unauthenticated on purpose.** "Can someone with the link open
  this?" is the reviewer's actual question; reviewers use their own accounts, not
  RISK's. YouTube goes through oEmbed, so unlisted passes and private doesn't.
- **Unrecognised applicant types and audition methods are shown, not guessed.**
  Under-surfacing an applicant is the worse failure.
- **Card state lives in KV** (`app:carded:<row>`), which is against the grain of
  "KV is idempotency + caches". It's the pragmatic home until rank 23 gives
  applications a sheet. Noted as a TODO in `intake.ts`.
- **The close clock starts when the card is posted**, not at the form timestamp.
  A row recovered late by the backstop therefore gets its full window, which errs
  toward giving the applicant more time.

```bash
npm test && npm run typecheck
```
