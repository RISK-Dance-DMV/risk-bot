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
import { readFileSync } from "node:fs";
import { COMMUNITY_GUILD_COMMANDS } from "../src/commands/definitions";
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
      new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"),
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
    else warn("not in the dance server — fine while DANCE_INVITE_URL is set");
  }

  const channels = await discord<{ id: string; name: string }[]>(
    `/guilds/${vars.GUILD_COMMUNITY_ID}/channels`,
    token,
  );
  if (!channels) {
    fail("can't list community channels — is the bot in that server?");
  } else {
    for (const key of ["CH_AUDITION_REVIEW", "CH_DIRECTORS_CONFIRMATION"]) {
      const wanted = normalizeChannelName(vars[key] ?? "");
      const hit = channels.find((c) => normalizeChannelName(c.name) === wanted);
      if (hit) ok(`#${vars[key]} → #${hit.name}`);
      else fail(`no channel matching #${vars[key]} in the community server`);
    }
  }

  const registered = await discord<{ name: string; id: string }[]>(
    `/applications/${vars.DISCORD_APPLICATION_ID}/guilds/${vars.GUILD_COMMUNITY_ID}/commands`,
    token,
  );
  if (!registered) {
    fail("can't read registered commands");
  } else {
    for (const command of COMMUNITY_GUILD_COMMANDS) {
      const hit = registered.find((c) => c.name === command.name);
      if (hit) ok(`/${command.name} registered (${hit.id})`);
      else fail(`/${command.name} NOT registered — run npm run register`);
    }
  }

  console.log("\nNot checkable from here");
  console.log("  · Cloudflare secrets (write-only)");
  console.log("  · KV: npx wrangler kv:key list --binding=KV --preview false");
  console.log("  · Apps Script deployment, templates sheet, form triggers");
  console.log("  · Interactions Endpoint URL in the Developer Portal");
  console.log("  · Integrations → RISK bot → per-command director access");

  console.log(`\n${problems === 0 ? "No problems found." : `${problems} problem(s).`}\n`);
  process.exit(problems > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
