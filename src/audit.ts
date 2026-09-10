/**
 * Audit trail. "Log every click with who made it" (design doc rank 6).
 *
 * TODO: the doc's system of record is the Audit Log sheet
 * (timestamp | action | target_discord_id | actor | detail), which needs the
 * service-account Sheets client that doesn't exist yet. Until then entries land
 * in KV and the Worker log. Keep every caller behind audit() so that swap is one
 * function.
 */
import type { Env } from "./env";

const AUDIT_TTL = 400 * 24 * 60 * 60;

export interface AuditEntry {
  action: string;
  actor?: string;
  target?: string;
  detail?: string;
}

export async function audit(env: Env, entry: AuditEntry): Promise<void> {
  const timestamp = new Date().toISOString();
  const record = { timestamp, ...entry };
  console.log("audit", JSON.stringify(record));

  // Suffix keeps two entries in the same millisecond from colliding.
  const suffix = Math.random().toString(36).slice(2, 8);
  try {
    await env.KV.put(`audit:${timestamp}:${suffix}`, JSON.stringify(record), {
      expirationTtl: AUDIT_TTL,
    });
  } catch (err) {
    // An audit write must never take down the action it is recording.
    console.error("audit write failed", err);
  }
}
