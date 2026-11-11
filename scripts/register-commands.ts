/**
 * Registers slash commands in the community guild.
 *
 * Uses POST per command rather than a bulk overwrite: POST upserts by name and
 * keeps the command's ID, which matters because the layer-2 director overrides
 * added by hand in Server Settings -> Integrations are attached to that ID and
 * are lost if it changes (design doc s2).
 *
 *   npm run register
 */
import { readFileSync } from "node:fs";
import {
  COMMUNITY_GUILD_COMMANDS,
  DANCE_GUILD_COMMANDS,
  INVITE_PERMISSIONS,
} from "../src/commands/definitions";

interface LoadedEnv {
  values: Record<string, string>;
  /** False when .dev.vars is absent — a different problem from an empty key. */
  foundFile: boolean;
}

/**
 * Reads a plain `KEY = "value"` out of wrangler.toml.
 *
 * A deliberately minimal parse rather than a TOML dependency: the only values
 * read here are the non-secret Discord IDs, which are simple quoted strings.
 */
function fromWranglerToml(key: string): string {
  try {
    const match = readFileSync("wrangler.toml", "utf8").match(
      new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"),
    );
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Precedence: environment, then .dev.vars, then wrangler.toml.
 *
 * Cloudflare secrets are deliberately absent from that list — once set they are
 * write-only, so a local script can never read them. Only the bot token is a real
 * secret here; the IDs live in wrangler.toml where they're visible and versioned.
 */
function loadEnv(): LoadedEnv {
  const values: Record<string, string> = { ...(process.env as Record<string, string>) };
  let foundFile = false;

  try {
    const contents = readFileSync(".dev.vars", "utf8");
    foundFile = true;
    for (const line of contents.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match?.[1] && !values[match[1]]) values[match[1]] = (match[2] ?? "").trim();
    }
  } catch {
    // Absent is legitimate when the values are already in the environment; the
    // caller decides whether that's worth mentioning.
  }

  for (const key of ["DISCORD_APPLICATION_ID", "GUILD_COMMUNITY_ID", "GUILD_DANCE_ID"]) {
    if (!values[key]) values[key] = fromWranglerToml(key);
  }

  return { values, foundFile };
}

function inviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${INVITE_PERMISSIONS}&scope=bot+applications.commands`;
}

/**
 * Turns a raw Discord error into something actionable.
 *
 * "Missing Access" on this endpoint almost always means the bot isn't in the
 * guild at all, so the most useful thing to print is which guilds it IS in.
 */
async function explainFailure(
  status: number,
  body: string,
  token: string,
  appId: string,
  guildId: string,
): Promise<void> {
  const missingAccess = body.includes("50001") || status === 403;
  if (!missingAccess) return;

  console.error("That's Discord code 50001. For guild commands it means one of:");
  console.error("  • the bot isn't in that server");
  console.error("  • it was invited with the `bot` scope but not `applications.commands`\n");

  try {
    const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.ok) {
      const guilds = (await res.json()) as { id: string; name: string }[];
      if (guilds.length === 0) {
        console.error("The bot is in no servers at all.");
      } else {
        console.error("The bot is currently in:");
        for (const g of guilds) {
          const mark = g.id === guildId ? " ← the one you're registering to" : "";
          console.error(`  ${g.id}  ${g.name}${mark}`);
        }
      }
      const inTarget = guilds.some((g) => g.id === guildId);
      console.error(
        inTarget
          ? `\nIt IS in ${guildId}, so re-invite it with the applications.commands scope:`
          : `\nIt is NOT in ${guildId}. Invite it:`,
      );
    } else {
      console.error("Invite it with:");
    }
  } catch {
    console.error("Invite it with:");
  }

  console.error(`\n  ${inviteUrl(appId)}\n`);
}

async function main(): Promise<void> {
  const { values: env, foundFile } = loadEnv();
  // Default to "" rather than undefined so the emptiness check below is also the
  // type narrowing — an unset key and a blank one are the same problem here.
  const token = env.DISCORD_BOT_TOKEN ?? "";
  const appId = env.DISCORD_APPLICATION_ID ?? "";
  const guildId = env.GUILD_COMMUNITY_ID ?? "";

  const missing = [
    ["DISCORD_BOT_TOKEN", token],
    ["DISCORD_APPLICATION_ID", appId],
    ["GUILD_COMMUNITY_ID", guildId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.error(`Missing: ${missing.join(", ")}\n`);
    console.error("Note: `wrangler secret put` does NOT help here. Cloudflare secrets");
    console.error("are write-only, so this script can't read them back.\n");

    if (missing.includes("DISCORD_APPLICATION_ID") || missing.includes("GUILD_COMMUNITY_ID")) {
      console.error("These two are not secrets — put them in wrangler.toml under [vars]:");
      console.error('  DISCORD_APPLICATION_ID = "..."   Developer Portal → General Information');
      console.error('  GUILD_COMMUNITY_ID = "..."       Developer Mode on → right-click the');
      console.error("                                   community server → Copy Server ID\n");
    }

    if (missing.includes("DISCORD_BOT_TOKEN")) {
      console.error("The bot token IS a secret, so it goes in .dev.vars (gitignored):");
      if (!foundFile) console.error("  cp .dev.vars.example .dev.vars");
      console.error("  DISCORD_BOT_TOKEN=...            Developer Portal → Bot → Reset Token");
    }
    process.exit(1);
  }

  const danceGuildId = env.GUILD_DANCE_ID ?? "";
  const targets: { guildId: string; label: string; commands: readonly unknown[] }[] = [
    { guildId, label: "community", commands: COMMUNITY_GUILD_COMMANDS },
  ];
  // Skipped rather than failed when unset: the dance guild only matters once
  // rank 12 is in play, and everything before it registers fine without it.
  if (danceGuildId) {
    targets.push({ guildId: danceGuildId, label: "dance", commands: DANCE_GUILD_COMMANDS });
  } else {
    console.log(
      "GUILD_DANCE_ID isn't in wrangler.toml or the environment — skipping the\n" +
        "dance guild, so /audition will not be registered.\n",
    );
  }

  for (const target of targets) {
  for (const command of target.commands as { name: string }[]) {
    const res = await fetch(
      `https://discord.com/api/v10/applications/${appId}/guilds/${target.guildId}/commands`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      console.error(`/${command.name}: HTTP ${res.status} ${body}\n`);
      await explainFailure(res.status, body, token, appId, target.guildId);
      process.exit(1);
    }
    const body = (await res.json()) as { id: string };
    console.log(`/${command.name} → ${body.id} (${target.label})`);
  }
  }

  console.log(
    "\nCommands are hidden by default_member_permissions: 0.\n" +
      "Grant directors access in Server Settings → Integrations → RISK bot.\n" +
      "If a command's ID ever changes, those overrides are dropped and must be re-applied.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
