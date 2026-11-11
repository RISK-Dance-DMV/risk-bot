/**
 * The audition loop (design doc rank 12).
 *
 *   trainee  /audition propose      -> proposal card to #coaches-bot-confirmation
 *   coach    [Approve] / [Ask for another song] / [Decline this cycle]  -> DM
 *   trainee  /audition submit       -> audition card to #audition-review
 *   coach    [Pass] / [Did not pass] -> DM, then a subunit pick on a pass
 *
 * Records live in KV, the same place application cards live. The doc's system
 * of record is the Auditions tab of the RISK Training Program sheet, which is
 * rank 7 and doesn't exist; when it does, this moves and KV goes back to being
 * idempotency markers.
 *
 * Nothing here emails. Every word a trainee receives is a DM, because rank 12
 * runs in #trainee-bot with every reply ephemeral and there is nowhere else to
 * say it.
 */
import { getCoachRoleId, getDirectorIds, getSubunitRoleId } from "../config/directors";
import { emptyDecision, type Decision } from "../applications/decision";
import {
  composeFeedback,
  isReviewSettled,
  resultMessage,
  reviewPlacement,
  reviewStatus,
} from "./review";
import { isEnabled } from "../config/flags";
import { getNumber } from "../config/settings";
import {
  addRole,
  archiveThread,
  memberRoles,
  createThreadOnMessage,
  editMessage,
  postMessage,
  postToChannelByName,
  removeRole,
  sendDirectMessage,
} from "../discord/rest";
import type { Env } from "../env";
import {
  auditionState,
  isAuditionTarget,
  isProposalClosed,
  MAX_EXTENSION_DAYS,
  deadline,
  dueDateFrom,
  extendedDeadline,
  extensionPending,
  hasLapsed,
  isUnresolved,
  needsReminder,
  type AuditionRecord,
  type AuditionResult,
} from "./audition";
import { renderProposalCard, renderReviewCard } from "./auditionCard";

const RECORD_PREFIX = "aud:rec:";
const CURRENT_PREFIX = "aud:current:";
/** A cycle is two months; an attempt outliving that is history, not state. */
const AUDITION_TTL = 400 * 24 * 60 * 60;

const recordKey = (id: string) => `${RECORD_PREFIX}${id}`;
const currentKey = (discordId: string) => `${CURRENT_PREFIX}${discordId}`;

function newAuditionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getAudition(env: Env, id: string): Promise<AuditionRecord | null> {
  return env.KV.get<AuditionRecord>(recordKey(id), "json");
}

export async function putAudition(env: Env, audition: AuditionRecord): Promise<void> {
  await env.KV.put(recordKey(audition.auditionId), JSON.stringify(audition), {
    expirationTtl: AUDITION_TTL,
  });
}

/** The trainee's most recent attempt, whatever state it's in. */
export async function currentAudition(
  env: Env,
  discordId: string,
): Promise<AuditionRecord | null> {
  const id = await env.KV.get(currentKey(discordId));
  return id ? getAudition(env, id) : null;
}

export type FlowResult =
  | { ok: true; audition: AuditionRecord; warning?: string }
  | { ok: false; reason: string };

// ------------------------------------------------------------ card plumbing

/** Redraws whichever cards exist. Missing ones are skipped, not created. */
async function reviewOptions(
  env: Env,
): Promise<{ directorIds: string[]; minVotes: number; simulate: boolean }> {
  const [directorIds, minVotes, simulate] = await Promise.all([
    getDirectorIds(env),
    getNumber(env, "trainee_min_votes"),
    isEnabled(env, "simulate_votes"),
  ]);
  return { directorIds, minVotes, simulate };
}

async function refreshCards(env: Env, audition: AuditionRecord): Promise<void> {
  if (audition.proposalChannelId && audition.proposalMessageId) {
    await editMessage(
      env,
      audition.proposalChannelId,
      audition.proposalMessageId,
      renderProposalCard(audition),
    );
  }
  if (audition.reviewChannelId && audition.reviewMessageId) {
    await editMessage(
      env,
      audition.reviewChannelId,
      audition.reviewMessageId,
      renderReviewCard(audition, await reviewOptions(env)),
    );
  }
}

/**
 * Writes the record, redraws the cards, and logs what happened in the
 * proposal's thread.
 *
 * The thread is the timeline: the card only ever shows the current state, so
 * without this there's no way to see that a song was approved on Tuesday, an
 * extension was asked for on Thursday and denied on Friday.
 *
 * Order matters twice. The card is redrawn before the note, so someone reading
 * the notification sees a card that already agrees with it. And the note is
 * posted before the archive, because posting to an archived thread reopens it —
 * archive first and the thread bounces straight back open.
 */
async function commit(
  env: Env,
  audition: AuditionRecord,
  note?: string,
  pingCoach = false,
): Promise<AuditionRecord> {
  const closing =
    !!audition.proposalThreadId &&
    !audition.proposalThreadArchived &&
    isProposalClosed(audition);
  const next = closing ? { ...audition, proposalThreadArchived: true } : audition;

  await putAudition(env, next);
  await refreshCards(env, next);

  if (note && next.proposalThreadId) {
    // Trainee-initiated events get the coach role. A proposal doesn't need one
    // — it arrives as a new message in the channel with buttons on it — but an
    // extension or a submission lands inside a thread nobody is watching.
    const roleId = pingCoach && !(await isEnabled(env, "quiet_pings"))
      ? await getCoachRoleId(env)
      : null;
    try {
      await postMessage(env, next.proposalThreadId, {
        content: roleId ? `<@&${roleId}> ${note}` : note,
        allowed_mentions: roleId ? { parse: [], roles: [roleId] } : { parse: [] },
        flags: 4,
      });
    } catch (err) {
      // The card is still right. A missing line in the log isn't worth failing
      // the thing the line was describing.
      console.error("couldn't post to the proposal thread", next.proposalThreadId, err);
    }
  }

  if (closing && next.proposalThreadId) {
    try {
      await archiveThread(env, next.proposalThreadId);
    } catch (err) {
      console.error("couldn't archive the proposal thread", next.proposalThreadId, err);
    }
  }
  return next;
}

/** A quoted block, for putting somebody's own words in the timeline. */
function quoted(text: string): string {
  return text.trim() ? `\n> ${text.trim().split("\n").join("\n> ")}` : "";
}

function whenUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * Tells the trainee, and says so on the coaches' card when it couldn't.
 *
 * A trainee with DMs closed is common and is not a reason to leave them
 * uninformed — it's a reason for a human to go and tell them.
 */
async function tell(env: Env, audition: AuditionRecord, body: string): Promise<void> {
  const delivered = await sendDirectMessage(env, audition.discordId, {
    content: body,
    allowed_mentions: { parse: [] },
  });
  if (delivered) return;

  const notice = {
    content: `⚠️ Couldn't DM <@${audition.discordId}> — their DMs are closed. Someone will need to tell them:\n> ${body.split("\n").join("\n> ")}`,
    allowed_mentions: { parse: [] },
  };

  // Into the proposal's own thread where there is one, so the notice sits with
  // the decision that couldn't be delivered.
  try {
    if (audition.proposalThreadId) {
      await postMessage(env, audition.proposalThreadId, notice);
      return;
    }
  } catch (err) {
    console.error("couldn't post the DM-failure notice to the thread", err);
  }
  await postToChannelByName(env, env.GUILD_DANCE_ID, env.CH_COACHES_CONFIRMATION, notice);
}

// ------------------------------------------------------------------- propose

export interface ProposalInput {
  targetSubunit: string;
  song: string;
  songLink: string;
  timestamp: string;
  /** Titles the trainee's thread on their first proposal. */
  displayName?: string;
}

/**
 * Posts a proposal and opens its own thread.
 *
 * One thread per proposal, not per trainee: a proposal is the unit coaches
 * discuss, and a single long-running trainee thread mixes a live question in
 * with every answered one. The thread is archived when the proposal closes,
 * so the channel's active list is exactly the proposals still owed an answer.
 */
async function postProposal(
  env: Env,
  audition: AuditionRecord,
  displayName: string,
): Promise<{ id: string; channelId: string; threadId?: string }> {
  const posted = await postToChannelByName(
    env,
    env.GUILD_DANCE_ID,
    env.CH_COACHES_CONFIRMATION,
    renderProposalCard(audition),
  );

  // Best-effort: a proposal without a thread is still a working proposal, and
  // losing it because the thread failed would be the worse trade.
  let threadId: string | undefined;
  try {
    threadId = await createThreadOnMessage(
      env,
      posted.channelId,
      posted.id,
      `${displayName || audition.discordId} · ${audition.song}`,
    );
  } catch (err) {
    console.error("couldn't open a proposal thread", audition.auditionId, err);
  }

  return { ...posted, threadId };
}

export async function proposeAudition(
  env: Env,
  discordId: string,
  input: ProposalInput,
): Promise<FlowResult> {
  const existing = await currentAudition(env, discordId);
  if (existing && isUnresolved(existing)) {
    const state = auditionState(existing);
    return {
      ok: false,
      reason:
        state === "proposed"
          ? "You already have a proposal waiting on a coach. They'll get back to you."
          : state === "approved"
            ? "Your audition is approved and still open — use `/audition submit` when you're ready."
            : "Your audition is submitted and waiting on a result.",
    };
  }

  if (!isAuditionTarget(input.targetSubunit)) {
    return { ok: false, reason: "Audition for Hearts or Spades — one, not both." };
  }
  if (!input.song.trim()) return { ok: false, reason: "That proposal needs a song." };
  if (!/^https?:\/\/\S+$/.test(input.songLink.trim())) {
    return { ok: false, reason: "That song link doesn't look like a URL." };
  }

  const audition: AuditionRecord = {
    auditionId: newAuditionId(),
    discordId,
    proposedOn: new Date().toISOString(),
    targetSubunit: input.targetSubunit,
    song: input.song.trim(),
    songLink: input.songLink.trim(),
    timestamp: input.timestamp.trim(),
    proposalStatus: "proposed",
    ...(input.displayName ? { displayName: input.displayName } : {}),
  };

  const posted = await postProposal(env, audition, input.displayName ?? "");

  const stored: AuditionRecord = {
    ...audition,
    proposalMessageId: posted.id,
    proposalChannelId: posted.channelId,
    ...(posted.threadId ? { proposalThreadId: posted.threadId } : {}),
  };
  await putAudition(env, stored);
  await env.KV.put(currentKey(discordId), stored.auditionId, { expirationTtl: AUDITION_TTL });
  return { ok: true, audition: stored };
}

// ------------------------------------------------- the coach answers it

export type ProposalDecision = "approve" | "another-song" | "decline";

export async function decideProposal(
  env: Env,
  auditionId: string,
  coachId: string,
  decision: ProposalDecision,
  note = "",
): Promise<FlowResult> {
  const audition = await getAudition(env, auditionId);
  if (!audition) return { ok: false, reason: "That audition is no longer on file." };
  if (auditionState(audition) !== "proposed") {
    return { ok: false, reason: `That proposal was already answered — it's \`${auditionState(audition)}\`.` };
  }

  const now = new Date().toISOString();
  let updated: AuditionRecord;
  let body: string;

  if (decision === "approve") {
    const days = await getNumber(env, "audition_days");
    const dueOn = dueDateFrom(now, days);
    updated = { ...audition, proposalStatus: "approved", approvedOn: now, dueOn, decidedBy: coachId };
    const unix = Math.floor(new Date(dueOn).getTime() / 1000);
    body =
      `✅ **Your audition song is approved** — *${audition.song}*.\n` +
      `Submit by <t:${unix}:D> (<t:${unix}:R>) with \`/audition submit\` in #${env.CH_TRAINEE_BOT}.\n` +
      "Need longer? `/audition extend` and say why.";
  } else if (decision === "another-song") {
    updated = {
      ...audition,
      proposalStatus: "another-song",
      decidedBy: coachId,
      proposalNote: note.trim() || undefined,
    };
    body =
      `🔁 **A coach would like a different song** — *${audition.song}* isn't the one.\n` +
      (note.trim() ? `\n> ${note.trim().split("\n").join("\n> ")}\n\n` : "") +
      "Nothing's been auditioned yet, so there's nothing to redo — just propose another whenever you're ready with `/audition propose`.";
  } else {
    updated = {
      ...audition,
      proposalStatus: "declined",
      decidedBy: coachId,
      proposalNote: note.trim() || undefined,
    };
    body =
      "🚫 **Your proposal was declined for this cycle.**" +
      (note.trim() ? `\n\n> ${note.trim().split("\n").join("\n> ")}` : "") +
      "\n\nTalk to a coach if you'd like to go through it.";
  }

  const line =
    decision === "approve"
      ? `✅ <@${coachId}> approved the song — due <t:${whenUnix(updated.dueOn ?? now)}:D>.`
      : decision === "another-song"
        ? `🔁 <@${coachId}> asked for another song.${quoted(note)}`
        : `🚫 <@${coachId}> declined this proposal.${quoted(note)}`;

  await commit(env, updated, line);
  await tell(env, updated, body);
  return { ok: true, audition: updated };
}

// -------------------------------------------------------------------- submit

export async function submitAudition(
  env: Env,
  discordId: string,
  url: string,
): Promise<FlowResult> {
  const audition = await currentAudition(env, discordId);
  if (!audition) return { ok: false, reason: "You don't have an audition open. Start with `/audition propose`." };

  const state = auditionState(audition);
  if (state === "proposed") {
    return { ok: false, reason: "Your song hasn't been approved yet — hold off until a coach answers." };
  }
  if (state === "submitted") {
    return { ok: false, reason: "You've already submitted. Ask a coach if you need to replace it." };
  }
  if (state !== "approved") {
    return { ok: false, reason: `There's nothing open to submit to — your last audition is \`${state}\`.` };
  }
  if (!/^https?:\/\/\S+$/.test(url.trim())) {
    return { ok: false, reason: "That submission link doesn't look like a URL." };
  }

  const submitted: AuditionRecord = {
    ...audition,
    submittedOn: new Date().toISOString(),
    submissionUrl: url.trim(),
  };

  // The video is judged in #audition-review, in the community guild, alongside
  // applicant videos.
  const posted = await postToChannelByName(
    env,
    env.GUILD_COMMUNITY_ID,
    env.CH_AUDITION_REVIEW,
    renderReviewCard(submitted, await reviewOptions(env)),
  );

  const stored: AuditionRecord = {
    ...submitted,
    reviewMessageId: posted.id,
    reviewChannelId: posted.channelId,
  };
  await commit(
    env,
    stored,
    `📼 <@${discordId}> submitted their audition — now in #${env.CH_AUDITION_REVIEW}.\n${stored.submissionUrl}`,
    true,
  );
  return { ok: true, audition: stored };
}

// -------------------------------------------------------------------- review

async function loadReviewable(
  env: Env,
  auditionId: string,
): Promise<{ audition: AuditionRecord; decision: Decision } | { reason: string }> {
  const audition = await getAudition(env, auditionId);
  if (!audition) return { reason: "That audition is no longer on file." };
  if (!audition.submittedOn) return { reason: "Nothing has been submitted yet." };
  if (audition.resultSentAt) return { reason: "The result has already gone out." };
  return { audition, decision: audition.decision ?? emptyDecision() };
}

/**
 * One director's ballot: a pass for the subunit they auditioned for, or not.
 *
 * Still stored as the applicant model's subunit list — `[target]` or `[]` —
 * so the tally, split detection and settle logic are shared rather than
 * reimplemented for a two-way question.
 */
export async function castBallot(
  env: Env,
  auditionId: string,
  userId: string,
  pass: boolean,
): Promise<FlowResult> {
  const loaded = await loadReviewable(env, auditionId);
  if ("reason" in loaded) return { ok: false, reason: loaded.reason };

  const decision: Decision = {
    ...loaded.decision,
    ballots: {
      ...loaded.decision.ballots,
      [userId]: pass ? [loaded.audition.targetSubunit] : [],
    },
  };
  const updated = await commit(env, { ...loaded.audition, decision }, `🗳️ <@${userId}> voted.`);
  return { ok: true, audition: updated };
}

/**
 * Test-only: casts every director's ballot at once.
 *
 * Goes through castBallot rather than writing the record directly, so it
 * exercises the real path — the split lock, the settle threshold, the thread
 * notes. A simulation that skipped those would prove nothing.
 *
 * Gated on features.simulate_votes, which is off by default.
 */
export async function simulateBallots(
  env: Env,
  auditionId: string,
  mode: "agree" | "split",
): Promise<FlowResult> {
  const loaded = await loadReviewable(env, auditionId);
  if ("reason" in loaded) return { ok: false, reason: loaded.reason };

  const { directorIds } = await reviewOptions(env);
  if (directorIds.length < 2) {
    return { ok: false, reason: "Needs at least two ids in `config:director_ids` to simulate." };
  }

  // Cleared first, so a re-run isn't merged into whatever was there before.
  await commit(env, {
    ...loaded.audition,
    decision: { ...loaded.decision, ballots: {}, final: undefined },
  });

  let last = loaded.audition;
  for (const [i, id] of directorIds.entries()) {
    // A split needs exactly one dissenter; everyone else passes.
    const pass = mode === "agree" ? true : i !== 1;
    const result = await castBallot(env, auditionId, id, pass);
    if (!result.ok) return result;
    last = result.audition;
  }
  return { ok: true, audition: last };
}

export async function saveReviewFeedback(
  env: Env,
  auditionId: string,
  userId: string,
  text: string,
): Promise<FlowResult> {
  const loaded = await loadReviewable(env, auditionId);
  if ("reason" in loaded) return { ok: false, reason: loaded.reason };

  const feedback = { ...loaded.decision.feedback };
  const trimmed = text.trim();
  // An empty box withdraws feedback rather than storing a blank.
  if (trimmed) feedback[userId] = { text: trimmed, at: new Date().toISOString() };
  else delete feedback[userId];

  // No thread note. The text is sealed until the vote settles, so the line
  // would carry nothing except that someone typed — and the card already shows
  // the count and who wrote. Editing your own wording shouldn't ping anybody.
  const updated = await commit(env, { ...loaded.audition, decision: { ...loaded.decision, feedback } });
  return { ok: true, audition: updated };
}

/** Settling a split: what the discussion landed on, or that it didn't. */
export async function recordReviewFinal(
  env: Env,
  auditionId: string,
  userId: string,
  pass: boolean,
): Promise<FlowResult> {
  const loaded = await loadReviewable(env, auditionId);
  if ("reason" in loaded) return { ok: false, reason: loaded.reason };

  const target = loaded.audition.targetSubunit;
  const decision: Decision = {
    ...loaded.decision,
    final: {
      outcome: pass ? "yes" : "no",
      by: userId,
      at: new Date().toISOString(),
      ...(pass ? { subunits: [target] } : {}),
    },
  };
  const updated = await commit(
    env,
    { ...loaded.audition, decision },
    pass
      ? `✅ <@${userId}> recorded a **pass for ${target}** after discussion.`
      : `🚫 <@${userId}> recorded **did not pass** after discussion.`,
  );
  return { ok: true, audition: updated };
}

/**
 * The one click that reaches the trainee: sends the result with everyone's
 * feedback, and on a pass assigns the roles.
 *
 * Deliberately a separate press rather than something the settling vote does
 * on its own — it's the only irreversible step in rank 12.
 */
export async function sendReviewResult(
  env: Env,
  auditionId: string,
  userId: string,
  body = "",
): Promise<FlowResult> {
  const loaded = await loadReviewable(env, auditionId);
  if ("reason" in loaded) return { ok: false, reason: loaded.reason };

  const { directorIds, minVotes } = await reviewOptions(env);
  const status = reviewStatus(loaded.decision, minVotes);
  if (!isReviewSettled(status)) {
    return { ok: false, reason: "The vote hasn't settled yet." };
  }

  const placed = reviewPlacement(loaded.decision, minVotes) ?? [];
  const target = loaded.audition.targetSubunit;
  const feedback = composeFeedback(loaded.decision, directorIds);
  let clubsLeft = false;

  if (placed.length > 0) {
    const roleIds: string[] = [];
    for (const subunit of placed) {
      const roleId = await getSubunitRoleId(env, subunit);
      if (!roleId) {
        return {
          ok: false,
          reason: `No role configured for ${subunit}. Set \`config:role.${subunit.toLowerCase()}\` — nothing was sent.`,
        };
      }
      roleIds.push(roleId);
    }

    // Roles before the DM: congratulating someone whose role never landed is
    // the worse of the two failures.
    try {
      for (const roleId of roleIds) {
        await addRole(env, env.GUILD_DANCE_ID, loaded.audition.discordId, roleId);
      }
    } catch (err) {
      return {
        ok: false,
        reason:
          `Couldn't assign the role: ${err instanceof Error ? err.message : String(err)}. ` +
          "Usually the bot's own role sits below it in Server Settings → Roles. Nothing was sent.",
      };
    }

    // Clubs comes off only once they hold Hearts *and* Spades. Passing into
    // one of them doesn't graduate anybody out of the trainee unit — so the
    // check is what they hold now, not what this audition just granted.
    const [clubsRoleId, heartsId, spadesId] = await Promise.all([
      getSubunitRoleId(env, "Clubs"),
      getSubunitRoleId(env, "Hearts"),
      getSubunitRoleId(env, "Spades"),
    ]);
    const held = await memberRoles(env, env.GUILD_DANCE_ID, loaded.audition.discordId);

    const inBoth =
      !!heartsId && !!spadesId && !!held && held.includes(heartsId) && held.includes(spadesId);

    if (clubsRoleId && held?.includes(clubsRoleId) && inBoth) {
      try {
        await removeRole(env, env.GUILD_DANCE_ID, loaded.audition.discordId, clubsRoleId);
      } catch (err) {
        console.error("couldn't remove Clubs", loaded.audition.discordId, err);
        clubsLeft = true;
      }
    } else if (clubsRoleId && held === null) {
      // Couldn't read their roles, so couldn't tell whether they're in both.
      // Leaving Clubs on is the recoverable half of that.
      clubsLeft = true;
    }
  }

  const updated: AuditionRecord = {
    ...loaded.audition,
    result: placed.length > 0 ? "pass" : "fail",
    reviewer: userId,
    resultSentAt: new Date().toISOString(),
    ...(placed.length > 0 ? { subunits: placed } : {}),
  };

  await commit(
    env,
    updated,
    placed.length > 0
      ? `📨 <@${userId}> sent the result — passed into **${placed.join(" + ")}**.`
      : `📨 <@${userId}> sent the result — did not pass.`,
  );

  // What the director actually read and approved, not a fresh render of it.
  await tell(env, updated, body || resultMessage(target, placed, feedback));

  return {
    ok: true,
    audition: updated,
    ...(clubsLeft
      ? { warning: "Couldn't check or change their Clubs role — take a look by hand." }
      : {}),
  };
}

// ----------------------------------------------------------------- extensions

export async function requestExtension(
  env: Env,
  discordId: string,
  days: number,
  reason: string,
): Promise<FlowResult> {
  const audition = await currentAudition(env, discordId);
  if (!audition || auditionState(audition) !== "approved") {
    return { ok: false, reason: "You don't have an approved audition waiting on a submission." };
  }
  if (extensionPending(audition)) {
    return { ok: false, reason: "You've already asked — a coach hasn't answered yet." };
  }
  if (!reason.trim()) return { ok: false, reason: "Say why, so a coach can answer." };
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXTENSION_DAYS) {
    return { ok: false, reason: `Ask for between 1 and ${MAX_EXTENSION_DAYS} days.` };
  }

  const updated: AuditionRecord = {
    ...audition,
    extension: { reason: reason.trim(), days, at: new Date().toISOString() },
  };
  await commit(
    env,
    updated,
    `⏳ <@${discordId}> asked for **${days} more day${days === 1 ? "" : "s"}**.${quoted(reason)}`,
    true,
  );
  return { ok: true, audition: updated };
}

export async function answerExtension(
  env: Env,
  auditionId: string,
  coachId: string,
  granted: boolean,
  note = "",
): Promise<FlowResult> {
  const audition = await getAudition(env, auditionId);
  if (!audition) return { ok: false, reason: "That audition is no longer on file." };
  if (!extensionPending(audition)) {
    return { ok: false, reason: "There's no extension request waiting on this one." };
  }

  const now = new Date().toISOString();
  const extension = {
    ...audition.extension!,
    granted,
    by: coachId,
    answeredAt: now,
    ...(note.trim() ? { note: note.trim() } : {}),
  };

  if (!granted) {
    const denied: AuditionRecord = { ...audition, extension };
    await commit(
      env,
      denied,
      `⏳ <@${coachId}> denied the extension — the original deadline stands.${quoted(note)}`,
    );
    await tell(
      env,
      denied,
      "Your extension request was declined — the original deadline stands." +
        (note.trim() ? `\n\n> ${note.trim().split("\n").join("\n> ")}` : ""),
    );
    return { ok: true, audition: denied };
  }

  // What they asked for, not a fixed number. extension_days is only the
  // fallback for a request made before the field existed.
  const days = audition.extension?.days ?? (await getNumber(env, "extension_days"));
  // Extended from the existing deadline, not from today: asking early should
  // not be worth less than asking late.
  const from = deadline(audition) ?? now;
  const extendedTo = extendedDeadline(from, days);
  const updated: AuditionRecord = { ...audition, extension, extendedTo };
  await commit(
    env,
    updated,
    `⏳ <@${coachId}> granted **${days} day${days === 1 ? "" : "s"}** — now due <t:${whenUnix(extendedTo)}:D>.`,
  );

  const unix = Math.floor(new Date(extendedTo).getTime() / 1000);
  await tell(env, updated, `⏳ **Extension granted** — you now have until <t:${unix}:D> (<t:${unix}:R>).`);
  return { ok: true, audition: updated };
}

// ----------------------------------------------------------------- deadlines

export interface DeadlineResult {
  skipped?: "flag_off";
  scanned: number;
  reminded: number;
  lapsed: number;
}

/**
 * Daily: the reminder the day before, and the lapse three days after.
 *
 * Both write a marker before they act, so a re-run of the same day doesn't DM
 * twice — the doc's rule for every cron here.
 */
export async function runAuditionDeadlines(env: Env): Promise<DeadlineResult> {
  const lapseDays = await getNumber(env, "audition_lapse_days");
  const now = new Date();

  let cursor: string | undefined;
  let scanned = 0;
  let reminded = 0;
  let lapsed = 0;

  do {
    const page = await env.KV.list({ prefix: RECORD_PREFIX, cursor });
    for (const key of page.keys) {
      const audition = await env.KV.get<AuditionRecord>(key.name, "json");
      if (!audition || auditionState(audition) !== "approved") continue;
      scanned++;

      if (hasLapsed(audition, lapseDays, now)) {
        const updated: AuditionRecord = { ...audition, lapsedOn: now.toISOString() };
        await commit(
          env,
          updated,
          "⌛ Lapsed — the deadline passed with nothing submitted.",
        );
        await tell(
          env,
          updated,
          "⌛ **Your audition window has closed** — the deadline passed without a " +
            `submission, so your ${audition.targetSubunit} audition for this cycle is closed.`,
        );
        lapsed++;
        continue;
      }

      if (needsReminder(audition, now)) {
        const updated: AuditionRecord = { ...audition, remindedOn: now.toISOString() };
        await commit(env, updated, "⏰ Reminder DM'd — due within the day.");
        const due = deadline(updated);
        const unix = due ? Math.floor(new Date(due).getTime() / 1000) : 0;
        await tell(
          env,
          updated,
          `⏰ **Your audition is due <t:${unix}:R>.** Submit with \`/audition submit\` in #${env.CH_TRAINEE_BOT}.`,
        );
        reminded++;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { scanned, reminded, lapsed };
}

/** Undoes an auto-lapse. The doc's escape hatch, and the reason a lapse isn't final. */
export async function reopenAudition(env: Env, auditionId: string): Promise<FlowResult> {
  const audition = await getAudition(env, auditionId);
  if (!audition) return { ok: false, reason: "That audition is no longer on file." };
  if (!audition.lapsedOn) return { ok: false, reason: "That audition hasn't lapsed." };

  const updated: AuditionRecord = {
    ...audition,
    lapsedOn: undefined,
    remindedOn: undefined,
    // Cleared so a second lapse archives the thread again — posting the note
    // below reopens it anyway.
    proposalThreadArchived: undefined,
  };
  await commit(env, updated, "↩️ Reopened — the deadline is a coach's call.");
  await tell(env, updated, "Your audition has been reopened — check with a coach on the new deadline.");
  return { ok: true, audition: updated };
}
