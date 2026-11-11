/**
 * Trainee auditions (design doc rank 12). Pure.
 *
 * The doc's Auditions table, one row per attempt:
 *   audition_id | discord_id | cycle_id | proposed_on | song | song_link |
 *   timestamp | proposal_status | approved_on | due_on | extended_to |
 *   submitted_on | submission_url | result | reviewer | notes
 *
 * Rank 12 sits on top of rank 7 (trainee_program), which isn't built. Two
 * fields reflect that and are deliberately optional rather than faked:
 * `cycleId`, which has nothing to name yet, and the proposal window, which is
 * computed from a cycle's `ends_on` and so isn't computed at all.
 */

import type { Decision } from "../applications/decision";

/**
 * What a trainee can audition for. Not Clubs — that's the trainee unit they're
 * already in, and they keep it until they hold both Hearts and Spades.
 */
export const AUDITION_TARGETS = ["Hearts", "Spades"] as const;

export function isAuditionTarget(value: string): boolean {
  return (AUDITION_TARGETS as readonly string[]).includes(value);
}

/** The coach's answer to a proposal. */
export type ProposalStatus = "proposed" | "approved" | "another-song" | "declined";

export type AuditionResult = "pass" | "fail";

export interface ExtensionRequest {
  reason: string;
  /** How many days they asked for. The coach grants this, or denies it. */
  days: number;
  at: string;
  /** Absent while the coach hasn't answered. */
  granted?: boolean;
  by?: string;
  answeredAt?: string;
  /** Why it was refused. Required on a denial, for the same reason a rejected
   * proposal carries one: "no" without a reason just invites asking again. */
  note?: string;
}

/** What a trainee may ask for. A month is already a conversation, not a form. */
export const MAX_EXTENSION_DAYS = 30;

export interface AuditionRecord {
  auditionId: string;
  discordId: string;
  /** Captured when they propose. An embed title can't render a mention. */
  displayName?: string;
  /** rank 7. Recorded when there is a cycle to attribute the row to. */
  cycleId?: string;
  proposedOn: string;
  /**
   * Which subunit they're auditioning for. Exactly one — a trainee auditions
   * for Hearts or for Spades, never both, so the directors' question is
   * "is this a pass for Hearts?" rather than "where does this person go?".
   */
  targetSubunit: string;
  song: string;
  songLink: string;
  timestamp: string;
  proposalStatus: ProposalStatus;
  approvedOn?: string;
  dueOn?: string;
  extendedTo?: string;
  extension?: ExtensionRequest;
  submittedOn?: string;
  submissionUrl?: string;
  result?: AuditionResult;
  reviewer?: string;
  lapsedOn?: string;
  /** Set once the due-date DM has gone out, so it goes out once. */
  remindedOn?: string;
  /**
   * Written on pass, when the coach picks where they land. A list because a
   * trainee can pass into both Hearts and Spades, and because someone already
   * holding one can pass into the other.
   */
  subunits?: string[];
  notes?: string;

  /** Whoever answered the proposal — approve, another song, or decline. */
  decidedBy?: string;

  /**
   * The directors' review of the submitted audition. Same model the applicant
   * cards use: a ballot is the subunit(s) to place them in, empty means they
   * didn't pass.
   */
  decision?: Decision;
  /** Set when the result has actually been sent to the trainee. */
  resultSentAt?: string;
  /**
   * Why the proposal was turned down, in the coach's words. Required on both
   * rejections: "propose something else" without saying what was wrong with
   * this one just makes the trainee guess, and they'll often guess wrong.
   */
  proposalNote?: string;

  /**
   * The two cards. Kept apart because they live in different guilds and are
   * edited at different moments; one pair of ids couldn't address both.
   */
  proposalMessageId?: string;
  proposalChannelId?: string;
  /** A thread per proposal, for whatever the coaches say about this one. */
  proposalThreadId?: string;
  /** Set once that thread has been archived, so it's archived once. */
  proposalThreadArchived?: boolean;
  reviewMessageId?: string;
  reviewChannelId?: string;
}

/**
 * Everything a trainee is told goes by DM (design doc rank 12 runs in
 * #trainee-bot with every reply ephemeral, so there is nowhere else to say it).
 * No part of this rank sends email, so none of it is gated on email_sends.
 */
export const TRAINEE_CONTACT = "dm" as const;

/**
 * What the card is actually asking for, derived rather than stored.
 *
 * A stored status and a set of timestamps that disagree is a bug you find by
 * reading a card that says the wrong thing; derived, they can't disagree.
 */
export type AuditionState =
  | "proposed"
  | "approved"
  | "submitted"
  | "passed"
  | "failed"
  | "lapsed"
  | "declined"
  | "another-song";

export function auditionState(audition: AuditionRecord): AuditionState {
  if (audition.result) return audition.result === "pass" ? "passed" : "failed";
  if (audition.lapsedOn) return "lapsed";
  if (audition.proposalStatus === "declined") return "declined";
  if (audition.proposalStatus === "another-song") return "another-song";
  if (audition.submittedOn) return "submitted";
  if (audition.proposalStatus === "approved") return "approved";
  return "proposed";
}

/**
 * Whether this audition still owes somebody something — which is what blocks a
 * trainee from proposing again.
 *
 * "Ask for another song" is resolved on purpose: it rejects the *proposal*, not
 * an audition — nothing has been performed yet — and it sends them straight
 * back to proposing, so treating it as outstanding would block the one action
 * it exists to invite.
 */
export function isUnresolved(audition: AuditionRecord): boolean {
  const state = auditionState(audition);
  return state === "proposed" || state === "approved" || state === "submitted";
}

/** extended_to supersedes due_on. */
export function deadline(audition: AuditionRecord): string | undefined {
  return audition.extendedTo ?? audition.dueOn;
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function dueDateFrom(approvedOn: string, auditionDays: number): string {
  return addDays(approvedOn, auditionDays);
}

export function extendedDeadline(from: string, extensionDays: number): string {
  return addDays(from, extensionDays);
}

/**
 * When an unsubmitted audition lapses.
 *
 * The doc's rule, and the reason for it: the grace period stays shorter than an
 * extension, or ignoring the deadline beats asking for more time.
 */
export function lapsesAt(
  audition: AuditionRecord,
  lapseDays: number,
): string | undefined {
  const due = deadline(audition);
  return due ? addDays(due, lapseDays) : undefined;
}

export function hasLapsed(
  audition: AuditionRecord,
  lapseDays: number,
  now: Date,
): boolean {
  if (auditionState(audition) !== "approved") return false;
  const at = lapsesAt(audition, lapseDays);
  return at !== undefined && new Date(at).getTime() <= now.getTime();
}

/** The reminder goes out the day before the deadline, once. */
export function needsReminder(audition: AuditionRecord, now: Date): boolean {
  if (auditionState(audition) !== "approved" || audition.remindedOn) return false;
  const due = deadline(audition);
  if (!due) return false;
  return new Date(due).getTime() - now.getTime() <= 24 * 60 * 60 * 1000;
}

/**
 * Nothing further will happen to this proposal, however it ended.
 *
 * Used to collapse its card and archive its thread — the two things that stop
 * a finished proposal competing with the one that needs answering.
 */
export function isProposalClosed(audition: AuditionRecord): boolean {
  const state = auditionState(audition);
  return (
    state === "another-song" ||
    state === "declined" ||
    state === "lapsed" ||
    state === "passed" ||
    state === "failed"
  );
}

/** An extension the coach hasn't answered yet. */
export function extensionPending(audition: AuditionRecord): boolean {
  return !!audition.extension && audition.extension.granted === undefined;
}
