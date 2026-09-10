/**
 * Registers slash commands in the dance guild.
 *
 * Uses POST per command rather than a bulk overwrite: POST upserts by name and
 * keeps the command's ID, which matters because the layer-2 director overrides
 * added by hand in Server Settings -> Integrations are attached to that ID and
 * are lost if it changes (design doc s2).
 *
 *   npm run register
 */
import { readFileSync } from "node:fs";
import { DANCE_GUILD_COMMANDS } from "../src/commands/definitions";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  try {
    for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match?.[1] && !env[match[1]]) env[match[1]] = (match[2] ?? "").trim();
    }
  } catch {
    // .dev.vars is optional when the values are already in the environment.
  }
  return env;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const token = env.DISCORD_BOT_TOKEN;
  const appId = env.DISCORD_APPLICATION_ID;
  const guildId = env.GUILD_DANCE_ID;

  const missing = [
    ["DISCORD_BOT_TOKEN", token],
    ["DISCORD_APPLICATION_ID", appId],
    ["GUILD_DANCE_ID", guildId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.error(`Missing: ${missing.join(", ")} (set them in .dev.vars or the environment)`);
    process.exit(1);
  }

  for (const command of DANCE_GUILD_COMMANDS) {
    const res = await fetch(
      `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
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
      console.error(`/${command.name}: HTTP ${res.status}`, await res.text());
      process.exit(1);
    }
    const body = (await res.json()) as { id: string };
    console.log(`/${command.name} → ${body.id}`);
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
