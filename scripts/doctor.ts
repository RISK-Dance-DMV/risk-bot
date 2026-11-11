/**
 * Checks the parts of the setup that live outside the code.
 *
 *   npm run doctor
 *
 * Covers wrangler.toml completeness and everything reachable with the bot token:
 * which servers the bot is in, whether the configured channels exist there, and
 * which commands are registered. It cannot see Cloudflare secrets (write-only) or
 * the Apps Script side - for those, run the daily job and read its output.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { COMMUNITY_GUILD_COMMANDS, DANCE_GUILD_COMMANDS } from "../src/commands/definitions";
import { normalizeChannelName } from "../src/discord/channelName";

const API = "https://discord.com/api/v10";

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);

function tomlVar(key: string): string {
  try {
    const m = readFileSync("wrangler.toml", "utf8").match(
      new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"),
    );
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function devVar(key: string): string {
  try {
    const m = readFileSync(".dev.vars", "utf8").match(
      new RegExp(`^[^\\S\\n]*${key}[^\\S\\n]*=[^\\S\\n]*(.*)$`, "m"),
    );
    return (m?.[1] ?? "").trim();
  } catch {
    return "";
  }
}

async function discord<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  return res.ok ? ((await res.json()) as T) : null;
}

async function main(): Promise<void> {
  let problems = 0;
  const fail = (m: string) => {
    bad(m);
    problems++;
  };

  console.log("\nwrangler.toml");
  const required = [
    "DISCORD_APPLICATION_ID",
    "GUILD_COMMUNITY_ID",
    "CH_AUDITION_REVIEW",
    "CH_TRAINEE_BOT",
    "CH_ANNOUNCEMENTS",
    "CH_COACHES_CONFIRMATION",
    "CH_DIAMONDS_BOT",
    "CH_DIRECTORS_CONFIRMATION",
    "APPLICATION_SHEET_URL",
    "ROLE_DIRECTOR_ID",
  ];
  const vars: Record<string, string> = {};
  for (const key of required) {
    vars[key] = tomlVar(key);
    if (vars[key]) ok(`${key} set`);
    else fail(`${key} is empty`);
  }

  for (const key of ["COMMUNITY_INVITE_URL", "DANCE_INVITE_URL"]) {
    const value = tomlVar(key);
    if (value) ok(`${key} set — must be a non-expiring, unlimited-use link`);
    else warn(`${key} unset — the bot will mint invites instead`);
  }

  console.log("\nDiscord");
  const token = process.env.DISCORD_BOT_TOKEN ?? devVar("DISCORD_BOT_TOKEN");
  if (!token) {
    fail("DISCORD_BOT_TOKEN missing from .dev.vars — can't check anything Discord-side");
    console.log(`\n${problems} problem(s).\n`);
    process.exit(problems > 0 ? 1 : 0);
  }

  const guilds = await discord<{ id: string; name: string }[]>("/users/@me/guilds", token);
  if (!guilds) {
    fail("bot token rejected by Discord");
  } else {
    const community = guilds.find((g) => g.id === vars.GUILD_COMMUNITY_ID);
    if (community) ok(`in the community server (${community.name})`);
    else fail(`NOT in the community server ${vars.GUILD_COMMUNITY_ID}`);

    const danceId = tomlVar("GUILD_DANCE_ID");
    const dance = guilds.find((g) => g.id === danceId);
    if (dance) ok(`in the dance server (${dance.name})`);
    else fail("not in the dance server — rank 12 (/audition) needs it");
  }

  // Both guilds, because rank 12 lives entirely in the dance one and a command
  // that registered to the wrong server looks identical to one that didn't
  // register at all.
  const guildChecks = [
    {
      label: "community",
      id: vars.GUILD_COMMUNITY_ID ?? "",
      channelKeys: ["CH_AUDITION_REVIEW", "CH_DIRECTORS_CONFIRMATION"],
      commands: COMMUNITY_GUILD_COMMANDS as readonly { name: string }[],
    },
    {
      label: "dance",
      id: tomlVar("GUILD_DANCE_ID"),
      channelKeys: [
        "CH_TRAINEE_BOT",
        "CH_COACHES_CONFIRMATION",
        "CH_ANNOUNCEMENTS",
        "CH_DIAMONDS_BOT",
      ],
      commands: DANCE_GUILD_COMMANDS as readonly { name: string }[],
    },
  ];

  for (const check of guildChecks) {
    console.log(`\n${check.label} server`);
    if (!check.id) {
      warn(`no guild id configured — skipping`);
      continue;
    }

    const channels = await discord<{ id: string; name: string }[]>(
      `/guilds/${check.id}/channels`,
      token,
    );
    if (!channels) {
      fail(`can't list ${check.label} channels — is the bot in that server?`);
    } else {
      for (const key of check.channelKeys) {
        const wanted = normalizeChannelName(vars[key] ?? "");
        const hit = channels.find((c) => normalizeChannelName(c.name) === wanted);
        if (hit) ok(`#${vars[key]} → #${hit.name}`);
        else fail(`no channel matching #${vars[key]} in the ${check.label} server`);
      }
    }

    const registered = await discord<{ name: string; id: string }[]>(
      `/applications/${vars.DISCORD_APPLICATION_ID}/guilds/${check.id}/commands`,
      token,
    );
    if (!registered) {
      fail(`can't read commands registered to the ${check.label} server`);
    } else {
      for (const command of check.commands) {
        const hit = registered.find((c) => c.name === command.name);
        if (hit) ok(`/${command.name} registered (${hit.id})`);
        else fail(`/${command.name} NOT registered in ${check.label} — run npm run register`);
      }
      // A command registered to the wrong guild is worth naming: it works for
      // nobody and looks like it was never registered.
      const expected = new Set(check.commands.map((c) => c.name));
      for (const extra of registered.filter((c) => !expected.has(c.name))) {
        warn(`/${extra.name} is registered here but isn't meant to be`);
      }
    }
  }

  await checkRoleHierarchy(vars, token, tomlVar("GUILD_DANCE_ID"), fail, warn);

  console.log("\nNot checkable from here");
  console.log("  · Cloudflare secrets (write-only)");
  console.log("  · KV: npx wrangler kv:key list --binding=KV --preview false");
  console.log("  · Apps Script deployment, templates sheet, form triggers");
  console.log("  · Interactions Endpoint URL in the Developer Portal");
  console.log("  · Integrations → RISK bot → per-command director access");

  console.log(`\n${problems === 0 ? "No problems found." : `${problems} problem(s).`}\n`);
  process.exit(problems > 0 ? 1 : 0);
}

/**
 * Reads one config key out of KV. Shells out to wrangler rather than reaching
 * for the API, so it uses whatever auth the rest of the workflow already has.
 */
function kv(key: string): string {
  try {
    return execFileSync(
      "npx",
      ["wrangler", "kv:key", "get", "--binding=KV", key, "--preview", "false"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Discord refuses to grant or remove a role positioned above the bot's own,
 * whatever permissions it holds. Nothing in the API says so up front — the
 * grant just 403s at the moment it matters, which is after a trainee has been
 * told they passed.
 */
async function checkRoleHierarchy(
  vars: Record<string, string>,
  token: string,
  danceGuildId: string,
  fail: (m: string) => void,
  warn: (m: string) => void,
): Promise<void> {
  console.log("\nrole hierarchy (dance)");
  if (!danceGuildId) {
    warn("no dance guild id — skipping");
    return;
  }

  const roles = await discord<{ id: string; name: string; position: number }[]>(
    `/guilds/${danceGuildId}/roles`,
    token,
  );
  const me = await discord<{ roles?: string[] }>(
    `/guilds/${danceGuildId}/members/${vars.DISCORD_APPLICATION_ID}`,
    token,
  );
  if (!roles || !me) {
    warn("couldn't read roles — skipping");
    return;
  }

  const byId = new Map(roles.map((r) => [r.id, r]));
  const mine = (me.roles ?? []).map((id) => byId.get(id)).filter(Boolean) as {
    name: string;
    position: number;
  }[];
  const top = mine.reduce((max, r) => Math.max(max, r.position), 0);

  let anyBlocked = false;
  for (const key of ["hearts", "spades", "clubs"]) {
    const id = kv(`config:role.${key}`);
    if (!id) {
      warn(`config:role.${key} not set — a pass into it can't assign anything`);
      continue;
    }
    const role = byId.get(id);
    if (!role) {
      fail(`config:role.${key} is ${id}, which isn't a role in the dance server`);
      continue;
    }
    if (top > role.position) {
      ok(`can manage ${role.name}`);
    } else {
      fail(`can't manage ${role.name} — the bot's own role sits below it`);
      anyBlocked = true;
    }
  }

  if (anyBlocked) {
    console.log(
      `  → Server Settings → Roles → drag the bot's role above them (it's at ${top}).`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
