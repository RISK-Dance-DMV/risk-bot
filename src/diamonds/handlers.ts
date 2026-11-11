/**
 * Interaction handling for Diamonds.
 *
 * Every dancer-facing reply is ephemeral and every result is a DM. #diamonds-bot
 * is a shared channel, and in a reveal-on-start round the piece must not be
 * rendered anywhere a second person can read it — an ephemeral reply is the
 * only place a bot can say something to one person in a channel.
 *
 * Gating follows rank 12 rather than commands/gate.ts: this lives in the dance
 * guild, the channel allowlist is #diamonds-bot, and the dancer-facing
 * subcommands are for everyone, so the director check is per-subcommand here.
 */
import { getDirectorIds, getSubunitRoleId, isDirector } from "../config/directors";
import { isEnabled } from "../config/flags";
import { ephemeral, json, modalValue } from "../discord/respond";
import { editOriginalResponse, resolveChannelId } from "../discord/rest";
import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  MODAL_TEXT_LIMIT,
  TextInputStyle,
  type Interaction,
  type MessagePayload,
} from "../discord/types";
import type { Env } from "../env";
import {
  DIMENSIONS,
  MAX_GROWTH_AREAS,
  MIN_STRENGTHS,
  activeRound,
  roomForThreeRounds,
  roundOf,
  composeFeedback,
  roundToScore,
  settleRound,
  tally,
  type Cohort,
  type Scores,
  type DiamondsTimeline,
  type Round,
  type Verdict,
} from "./audition";
import {
  ballotReceipt,
  configReadout,
  diamondsCustomId,
  resultMessage,
  parseDiamondsCustomId,
  parseRound,
  rosterReadout,
  roundPanel,
  statusPanel,
  type DiamondsAction,
  type PanelContext,
} from "./card";
import {
  getDiamondsTimeline,
  getDiamondsPolicy,
  inspectDiamondsConfig,
  setDiamondsTimeline,
  type DiamondsPolicy,
} from "./config";
import {
  addEntry,
  allRecords,
  assignPiece,
  assignToAll,
  fileFeedback,
  getRecord,
  grantExtension,
  panelContext,
  noteRound,
  planStart,
  register,
  scoreRound,
  sendResult,
  startWindow,
  submit,
  withdraw,
  type FlowResult,
} from "./flow";

export const diamondsComponent = parseDiamondsCustomId;

const DIRECTOR_ONLY = [
  "assign",
  "assign-all",
  "extend",
  "feedback",
  "score",
  "result",
  "roster",
  "add",
  "config",
  "schedule",
];

/**
 * The two that run while the flag is off.
 *
 * Setting the calendar and reading it back are *how you decide* whether to turn
 * the flag on, so gating them behind it would leave the only safe order of
 * operations impossible to follow.
 */
const BEFORE_LAUNCH = ["config", "schedule"];

function option(interaction: Interaction, sub: string, name: string): string {
  const subcommand = (interaction.data?.options ?? []).find(
    (one) => (one as { name?: string }).name === sub,
  ) as { options?: { name?: string; value?: unknown }[] } | undefined;
  const found = (subcommand?.options ?? []).find((one) => one.name === name);
  return found?.value === undefined ? "" : String(found.value);
}

function subcommandName(interaction: Interaction): string {
  const first = (interaction.data?.options ?? [])[0] as { name?: string } | undefined;
  return first?.name ?? "";
}

function callerId(interaction: Interaction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function displayNameOf(interaction: Interaction): string {
  const user = interaction.member?.user ?? interaction.user;
  return interaction.member?.nick ?? user?.global_name ?? user?.username ?? "";
}

const said = (result: FlowResult, done: string): MessagePayload => ({
  content: result.ok
    ? result.warning
      ? `${done}\n⚠️ ${result.warning}`
      : done
    : `❌ ${result.reason}`,
});

/**
 * Both commands and the button need the same three things, and reading them
 * together is one round trip rather than three.
 */
async function context(env: Env): Promise<{
  timeline: DiamondsTimeline;
  policy: DiamondsPolicy;
  ctx: PanelContext;
}> {
  const [timeline, policy] = await Promise.all([
    getDiamondsTimeline(env),
    getDiamondsPolicy(env),
  ]);
  return { timeline, policy, ctx: panelContext(timeline, policy) };
}

async function wrongChannel(env: Env, interaction: Interaction): Promise<string | null> {
  if (interaction.guild_id !== env.GUILD_DANCE_ID) {
    return "Diamonds auditions run in the dance server.";
  }
  let allowed: string;
  try {
    allowed = await resolveChannelId(env, env.GUILD_DANCE_ID, env.CH_DIAMONDS_BOT);
  } catch (err) {
    return `Couldn't find #${env.CH_DIAMONDS_BOT}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return interaction.channel_id === allowed ? null : `Use this in #${env.CH_DIAMONDS_BOT}.`;
}

/**
 * Returning or new, read off the clicker's own roles.
 *
 * Off the roles rather than asked, because the answer decides whether Round 0
 * wants a video from them — and someone who gets it wrong about themselves
 * either films something nobody needed or misses the one thing Round 0 asked
 * for. With no Diamonds role configured everyone is new, which is the safe way
 * round: it asks for a video that won't be held against them.
 */
async function cohortOf(env: Env, interaction: Interaction): Promise<Cohort> {
  const roleId = await getSubunitRoleId(env, "Diamonds");
  if (!roleId) return "new";
  return (interaction.member?.roles ?? []).includes(roleId) ? "returning" : "new";
}

/** A 0–10 score, or undefined when the option wasn't given. */
function scoreOption(
  interaction: Interaction,
  sub: string,
  name: string,
): number | undefined {
  const raw = option(interaction, sub, name).trim();
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The four, or undefined unless all four are there.
 *
 * All-or-nothing on purpose: three dimensions scored and one left blank is a
 * half-finished ballot, and averaging it against a complete one would weight
 * the missing dimension at whatever the other director happened to say.
 */
function scoresOption(interaction: Interaction, sub: string): Scores | undefined {
  const values = DIMENSIONS.map((one) => scoreOption(interaction, sub, one));
  if (values.some((one) => one === undefined)) return undefined;
  return Object.fromEntries(
    DIMENSIONS.map((one, index) => [one, values[index]!]),
  ) as Scores;
}

/** Round 0's ballot, which is a choice of two rather than a number. */
function verdictOption(interaction: Interaction): Verdict | undefined {
  const raw = option(interaction, "score", "verdict").trim();
  return raw === "pass" || raw === "fail" ? raw : undefined;
}

/** The user id out of a USER option, which arrives as a snowflake string. */
function userOption(interaction: Interaction, sub: string, name: string): string | null {
  const raw = option(interaction, sub, name).trim();
  return /^\d{15,}$/.test(raw) ? raw : null;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export async function handleDiamondsCommand(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
): Promise<Response> {
  const userId = callerId(interaction);
  if (!userId) return json(ephemeral("Couldn't tell who ran that."));

  const misplaced = await wrongChannel(env, interaction);
  if (misplaced) return json(ephemeral(misplaced));

  const sub = subcommandName(interaction);
  if (!BEFORE_LAUNCH.includes(sub) && !(await isEnabled(env, "diamonds"))) {
    return json(
      ephemeral(
        "Diamonds auditions are switched off. Directors: `/diamonds config` to see " +
          "what's set, and what turning it on would commit you to.",
      ),
    );
  }
  if (DIRECTOR_ONLY.includes(sub)) {
    const directorIds = await getDirectorIds(env);
    if (!isDirector(directorIds, userId)) {
      return json(ephemeral(`\`/diamonds ${sub}\` is directors only.`));
    }
  }

  // The document modal has to be the immediate response — there is no deferring
  // your way into one.
  if (sub === "feedback") {
    const dancer = userOption(interaction, "feedback", "dancer");
    if (!dancer) return json(ephemeral("Pick who the feedback is for."));
    const record = await getRecord(env, dancer);
    if (!record) return json(ephemeral(`<@${dancer}> isn't registered.`));

    const policy = await getDiamondsPolicy(env);
    const round = roundToScore(record, policy.minScores);
    if (round === undefined) {
      return json(ephemeral(`Nothing of <@${dancer}>'s is open for feedback right now.`));
    }
    // Checked before the modal rather than after it, so nobody writes three
    // paragraphs into a form that's going to refuse them.
    if (round === 0 && record.cohort === "new" && !roundOf(record, 0).submittedAt) {
      return json(
        ephemeral(
          `<@${dancer}> hasn't submitted a Round 0 cover yet, so there's nothing ` +
            `to write against. Returning Diamonds skip that step; newcomers don't.`,
        ),
      );
    }
    // Round 0's feedback is the one written document; Rounds 1 and 2 take one
    // note per director, like rank 12.
    return json(round === 0 ? feedbackModal(dancer, record.cohort) : noteModal(dancer, round));
  }

  // Everything else DMs somebody or lists the whole cohort, both past the 3s
  // budget.
  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        payload = await runSubcommand(env, interaction, sub, userId);
      } catch (err) {
        payload = {
          content: `That didn't go through: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await editOriginalResponse(env, interaction.application_id, interaction.token, payload);
    })(),
  );

  return json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL },
  });
}

/**
 * The round a dancer-facing subcommand acts on.
 *
 * Derived, never asked. Someone who has to know they're in Round 1 to run
 * `/diamonds submit` is someone the process has already failed.
 */
async function liveRound(
  env: Env,
  userId: string,
  now: Date,
): Promise<{ ok: true; round: Round } | { ok: false; reason: string }> {
  const record = await getRecord(env, userId);
  if (!record) {
    return {
      ok: false,
      reason: "You're not registered yet — run `/diamonds register` first.",
    };
  }
  return activeRound(record, now);
}

async function runSubcommand(
  env: Env,
  interaction: Interaction,
  sub: string,
  userId: string,
): Promise<MessagePayload> {
  const now = new Date();
  const { timeline, policy, ctx } = await context(env);

  if (sub === "register") {
    const cohort = await cohortOf(env, interaction);
    const planned = option(interaction, "register", "plan").trim();
    if (planned && !/^\d{4}-\d{2}-\d{2}$/.test(planned)) {
      return {
        content:
          "❌ Give the date as YYYY-MM-DD, e.g. `2026-11-29`. It's only an " +
          "estimate — you can change it by running this again.",
      };
    }
    const result = await register(
      env,
      userId,
      displayNameOf(interaction),
      cohort,
      planned || undefined,
      timeline,
      now,
    );
    if (!result.ok) return { content: `❌ ${result.reason}` };
    // The panel for whichever round is live, not Round 0's: someone registering
    // the day the pieces go up shouldn't be told to film a cover.
    const live = activeRound(result.record, now);
    return roundPanel(result.record, live.ok ? live.round : 0, ctx, now);
  }

  if (sub === "withdraw") {
    const result = await withdraw(env, userId);
    return said(
      result,
      "You're off the list. Run `/diamonds register` again if you change your mind " +
        "while the round you'd be joining is still open.",
    );
  }

  if (sub === "status" || sub === "start") {
    const live = await liveRound(env, userId, now);
    if (!live.ok) return { content: `❌ ${live.reason}` };
    const record = (await getRecord(env, userId))!;
    return sub === "status"
      ? statusPanel(record, live.round, ctx, now)
      : roundPanel(record, live.round, ctx, now);
  }

  if (sub === "plan") {
    const live = await liveRound(env, userId, now);
    if (!live.ok) return { content: `❌ ${live.reason}` };
    const result = await planStart(
      env,
      userId,
      live.round,
      option(interaction, "plan", "date"),
      timeline,
      policy,
      now,
    );
    return said(
      result,
      `📌 **Noted — Round ${live.round} around ${option(interaction, "plan", "date")}.** ` +
        `I'll remind you that morning. Not a commitment: change it with ` +
        `\`/diamonds plan\` whenever, as often as you like. It's just easier to ` +
        `hit a day you picked than one nobody picked.`,
    );
  }

  if (sub === "submit") {
    const live = await liveRound(env, userId, now);
    if (!live.ok) return { content: `❌ ${live.reason}` };
    const result = await submit(
      env,
      userId,
      live.round,
      option(interaction, "submit", "link"),
      timeline,
      policy,
      now,
    );
    return said(
      result,
      live.round === 0
        ? "📼 **Submitted.** You can replace it any time before the Round 0 deadline."
        : "📼 **Submitted.** That's the round done — feedback either way, whether or not you advance.",
    );
  }

  if (sub === "assign") {
    const dancer = userOption(interaction, "assign", "dancer");
    if (!dancer) return { content: "❌ Pick who the piece is for." };
    const round = parseRound(option(interaction, "assign", "round") || "1");
    if (round === null) return { content: "❌ Round has to be 0, 1 or 2." };
    const result = await assignPiece(
      env,
      dancer,
      round,
      option(interaction, "assign", "piece"),
      {
        note: option(interaction, "assign", "target"),
        before: scoreOption(interaction, "assign", "starting-score"),
      },
      timeline,
      policy,
      now,
    );
    return said(
      result,
      `🎬 Round ${round} piece is up for <@${dancer}> — they've been DM'd, and can ` +
        `start it themselves whenever they're ready.`,
    );
  }

  if (sub === "assign-all") {
    const round = parseRound(option(interaction, "assign-all", "round") || "2");
    if (round === null) return { content: "❌ Round has to be 0, 1 or 2." };
    const piece = option(interaction, "assign-all", "piece").trim();
    if (!piece) return { content: "❌ Give me the piece — a link, or the song." };

    const { assigned, skipped, unreachable, refused } = await assignToAll(
      env,
      round,
      piece,
      timeline,
      policy,
      now,
    );
    if (refused) return { content: `❌ ${refused}` };

    const lines = [
      `🎬 **Round ${round} piece out to ${assigned.length}.** Each of them has it ` +
        `privately and starts their own clock.`,
    ];
    if (skipped.length > 0) {
      lines.push(
        `Left alone (${skipped.length}): already started, already submitted, or not in this round.`,
      );
    }
    if (unreachable.length > 0) {
      lines.push(`⚠️ Couldn't DM: ${unreachable.map((one) => `<@${one}>`).join(", ")}`);
    }
    return { content: lines.join("\n") };
  }

  if (sub === "extend") {
    const dancer = userOption(interaction, "extend", "dancer");
    if (!dancer) return { content: "❌ Pick who the extension is for." };
    const round = parseRound(option(interaction, "extend", "round") || "1");
    if (round === null) return { content: "❌ Round has to be 0, 1 or 2." };
    const days = Number.parseInt(option(interaction, "extend", "days"), 10);
    const result = await grantExtension(
      env,
      dancer,
      round,
      days,
      option(interaction, "extend", "reason"),
      userId,
      policy,
    );
    return said(result, `⏳ <@${dancer}> has ${days} more day${days === 1 ? "" : "s"}.`);
  }

  if (sub === "add") {
    const dancer = userOption(interaction, "add", "dancer");
    if (!dancer) return { content: "❌ Pick who to add." };
    const cohort = option(interaction, "add", "cohort");
    if (cohort !== "new" && cohort !== "returning") {
      return { content: "❌ Cohort has to be `new` or `returning`." };
    }
    const live = activeRound({ discordId: dancer, cohort, rounds: {} }, now);
    const result = await addEntry(
      env,
      dancer,
      cohort,
      live.ok ? live.round : 0,
      timeline,
      policy,
      now,
    );
    return said(
      result,
      `✅ <@${dancer}> is on the list as **${cohort}**, and has been DM'd where ` +
        `things stand.` +
        (cohort === "new" && !roomForThreeRounds(timeline, policy, now)
          ? `\n⚠️ Past the point where three rounds still fit before auditions ` +
            `close. They can submit Round 0 and get feedback, but they can't finish ` +
            `this cycle unless you move the close date.`
          : ""),
    );
  }

  if (sub === "config") {
    return configReadout(await inspectDiamondsConfig(env));
  }

  if (sub === "schedule") {
    const set = await setDiamondsTimeline(env, {
      opensAt: option(interaction, "schedule", "opens"),
      closesAt: option(interaction, "schedule", "closes"),
    });
    if (!set.ok) return { content: `❌ ${set.reason}` };
    // Read back rather than echoed: the point of setting a date here is to find
    // out what the whole calendar now says, including whether it can be run.
    const readout = configReadout(await inspectDiamondsConfig(env));
    return {
      content: `📅 Set ${set.changed.length} date${set.changed.length === 1 ? "" : "s"}.\n\n${readout.content}`,
    };
  }

  if (sub === "score") {
    const dancer = userOption(interaction, "score", "dancer");
    if (!dancer) return { content: "❌ Pick who you're scoring." };
    const result = await scoreRound(
      env,
      dancer,
      userId,
      {
        verdict: verdictOption(interaction),
        targetScore: scoreOption(interaction, "score", "target-score"),
        scores: scoresOption(interaction, "score"),
      },
      policy,
      now,
    );
    if (!result.ok) return { content: `❌ ${result.reason}` };

    const receipt = ballotReceipt(
      result.record,
      result.round,
      result.tally,
      result.splits,
      result.settled,
      policy,
    );
    return {
      content: result.warning ? `${receipt.content}\n⚠️ ${result.warning}` : receipt.content,
    };
  }

  if (sub === "result") {
    const dancer = userOption(interaction, "result", "dancer");
    if (!dancer) return { content: "❌ Pick who the result is for." };
    const record = await getRecord(env, dancer);
    if (!record) return { content: `❌ <@${dancer}> isn't registered.` };

    const round = roundToScore(record, policy.minScores);
    if (round === undefined || round === 0) {
      return {
        content:
          round === 0
            ? `❌ Round 0 is a baseline, not a result. Their feedback is what goes ` +
              `out — \`/diamonds feedback\`.`
            : `❌ Nothing of <@${dancer}>'s is waiting on a result.`,
      };
    }

    const settled = settleRound(record, round, policy);
    const counted = tally(roundOf(record, round), policy.minScores);
    if (!settled) {
      return {
        content:
          `❌ Round ${round} isn't settled — ${counted.count} of ${policy.minScores} ` +
          `ballots in.`,
      };
    }

    // Read back exactly what they'll read, then one button. This is the only
    // irreversible step in the process, and the preview is built from the same
    // function the DM is — built separately they would eventually disagree, and
    // the preview would be a lie.
    const notes = composeFeedback(roundOf(record, round), await getDirectorIds(env));
    return {
      content:
        `**This is what <@${dancer}> will receive. Nothing has been sent yet.**` +
        (notes ? "" : `\n*No director has written anything — \`/diamonds feedback\` first if you meant to.*`) +
        `\n\n${resultMessage(record, round, settled, counted, notes, ctx, policy)}`,
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.BUTTON,
              style: ButtonStyle.DANGER,
              label: "Send this result",
              custom_id: diamondsCustomId("send", dancer),
            },
          ],
        },
      ],
    };
  }

  if (sub === "roster") return rosterReadout(await allRecords(env), ctx, now);

  return { content: "Unhandled subcommand." };
}

/* -------------------------------------------------------------------------- */
/* The button, and the document modal                                          */
/* -------------------------------------------------------------------------- */

export async function handleDiamondsComponent(
  env: Env,
  interaction: Interaction,
  ctx: ExecutionContext,
  action: DiamondsAction,
  arg: string,
): Promise<Response> {
  if (!(await isEnabled(env, "diamonds"))) {
    return json(ephemeral("Diamonds auditions are switched off."));
  }
  const userId = callerId(interaction);
  if (!userId) return json(ephemeral("Couldn't tell who pressed that."));

  if (action === "start") {
    const round = parseRound(arg);
    if (round === null) return json(ephemeral("That button has gone stale."));

    // Replaces the panel rather than replying beside it: the button has been
    // used, and an irreversible one that stays pressable is an invitation to
    // wonder whether it worked.
    ctx.waitUntil(
      (async () => {
        let payload: MessagePayload;
        try {
          const now = new Date();
          const { timeline, policy, ctx } = await context(env);
          const result = await startWindow(env, userId, round, timeline, policy, now);
          payload = result.ok
            ? roundPanel(result.record, round, ctx, now)
            : { content: `❌ ${result.reason}`, components: [] };
        } catch (err) {
          payload = {
            content: `That didn't go through: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        await editOriginalResponse(
          env,
          interaction.application_id,
          interaction.token,
          payload,
        );
      })(),
    );
    return json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  if (action === "send") {
    const dancer = arg;
    if (!/^\d{15,}$/.test(dancer)) return json(ephemeral("That button has gone stale."));

    // Replaces the preview, so a result that has gone out can't be sent twice
    // by someone scrolling back to an old ephemeral message.
    ctx.waitUntil(
      (async () => {
        let payload: MessagePayload;
        try {
          const now = new Date();
          const { policy, ctx: panels } = await context(env);
          const result = await sendResult(
            env,
            dancer,
            await getDirectorIds(env),
            panels,
            policy,
            now,
          );
          payload = result.ok
            ? {
                content:
                  `📨 **Sent to <@${dancer}>** — Round ${result.round}, ` +
                  `**${result.outcome}**. Recorded against the bar it was judged ` +
                  `by, so a later change to the bar won't rewrite it.` +
                  (result.outcome === "advanced"
                    ? `\nTheir final piece is the next thing they're waiting on.`
                    : ""),
                components: [],
              }
            : { content: `❌ ${result.reason}`, components: [] };
        } catch (err) {
          payload = {
            content: `That didn't go through: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        await editOriginalResponse(
          env,
          interaction.application_id,
          interaction.token,
          payload,
        );
      })(),
    );
    return json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  if (action === "note-save") {
    const dancer = arg;
    if (!/^\d{15,}$/.test(dancer)) return json(ephemeral("That form has gone stale."));

    ctx.waitUntil(
      (async () => {
        let payload: MessagePayload;
        try {
          const now = new Date();
          const { policy } = await context(env);
          const result = await noteRound(
            env,
            dancer,
            userId,
            modalValue(interaction, NOTE_INPUT),
            policy,
            now,
          );
          payload = result.ok
            ? {
                content:
                  `📝 **Noted on Round ${result.round}.** ` +
                  (result.sealed
                    ? `Hidden until the round settles, so it can't nudge anyone — ` +
                      `and it goes out with the result.`
                    : `The round is already settled, so it'll go out with the ` +
                      `result when you send it.`) +
                  `\nRun it again any time to replace what you wrote.`,
              }
            : { content: `❌ ${result.reason}` };
        } catch (err) {
          payload = {
            content: `That didn't go through: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        await editOriginalResponse(env, interaction.application_id, interaction.token, payload);
      })(),
    );

    return json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: MessageFlags.EPHEMERAL },
    });
  }

  // doc-save: the dancer's id, and nothing else. What Round 1 targets is set
  // later, with the piece — see `fixTarget`.
  const dancer = arg;
  if (!/^\d{15,}$/.test(dancer)) return json(ephemeral("That form has gone stale."));

  ctx.waitUntil(
    (async () => {
      let payload: MessagePayload;
      try {
        const now = new Date();
        const { timeline, policy } = await context(env);
        const result = await fileFeedback(
          env,
          dancer,
          {
            content: modalValue(interaction, DOC_CONTENT),
            strengths: lines(modalValue(interaction, DOC_STRENGTHS)),
            growthAreas: lines(modalValue(interaction, DOC_GROWTH)),
          },
          userId,
          timeline,
          policy,
          now,
        );
        // Not `said`: a held document must not be announced as sent, and the
        // held case is the normal one when you write before you've both
        // decided. So the two outcomes get two different sentences.
        payload = !result.ok
          ? { content: `❌ ${result.reason}` }
          : result.warning
            ? { content: `📄 **Written for <@${dancer}>.**\n⚠️ ${result.warning}` }
            : {
                content:
                  `📄 **Sent to <@${dancer}>, verdict and all.** That opens ` +
                  `Round 1 for them — put their piece up with ` +
                  `\`/diamonds assign\`, and say with it what the piece is ` +
                  `testing and where you have that today.`,
              };
      } catch (err) {
        payload = {
          content: `That didn't go through: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await editOriginalResponse(env, interaction.application_id, interaction.token, payload);
    })(),
  );

  return json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL },
  });
}

const NOTE_INPUT = "note-text";
const DOC_CONTENT = "doc-content";
const DOC_STRENGTHS = "doc-strengths";
const DOC_GROWTH = "doc-growth";

/** One per line, blanks dropped — a trailing newline isn't a fourth strength. */
function lines(value: string): string[] {
  return value
    .split("\n")
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
}

/**
 * One director's note on a round that ends in a result.
 *
 * Deliberately one free-text box rather than the Round 0 document's structure.
 * Round 0's job is to produce something the dancer can work from; this is a
 * director saying what they saw, in their own words, and a form would flatten
 * that into the same four paragraphs every time.
 */
function noteModal(dancer: string, round: Round): unknown {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: diamondsCustomId("note-save", dancer),
      title: `Round ${round} feedback`,
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: NOTE_INPUT,
              style: TextInputStyle.PARAGRAPH,
              label: "They read this as written, with their result",
              placeholder:
                round === 1
                  ? "What you saw of the thing you asked them to work on."
                  : "What stood out, and what didn't. Specific beats general.",
              max_length: MODAL_TEXT_LIMIT,
              required: true,
            },
          ],
        },
      ],
    },
  };
}

function feedbackModal(dancer: string, cohort: "new" | "returning"): unknown {
  const against =
    cohort === "returning" ? "this season" : "the cover they sent";
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: diamondsCustomId("doc-save", dancer),
      title: "Round 0 feedback",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: DOC_CONTENT,
              style: TextInputStyle.PARAGRAPH,
              label: "The feedback — they read this as written",
              placeholder: `What you saw in ${against}. Specific beats general.`,
              max_length: MODAL_TEXT_LIMIT,
              required: true,
            },
          ],
        },
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: DOC_STRENGTHS,
              style: TextInputStyle.PARAGRAPH,
              label: `Evident strengths, one per line (${MIN_STRENGTHS}+)`,
              placeholder: `What stood out in ${against}.`,
              max_length: MODAL_TEXT_LIMIT,
              required: true,
            },
          ],
        },
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: DOC_GROWTH,
              style: TextInputStyle.PARAGRAPH,
              label: `Opportunities to grow, one per line (max ${MAX_GROWTH_AREAS})`,
              placeholder: "Keep it to what one piece in three days could show movement on.",
              max_length: MODAL_TEXT_LIMIT,
              required: true,
            },
          ],
        },
      ],
    },
  };
}
