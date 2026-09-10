import { describe, expect, it } from "vitest";
import { declineReason } from "../src/commands/gate";
import type { Interaction } from "../src/discord/types";
import type { Env } from "../src/env";

const DIRECTORS_CHANNEL_ID = "555";

const env = {
  GUILD_DANCE_ID: "dance",
  ROLE_DIRECTOR_ID: "director-role",
  CH_DIRECTORS_CONFIRMATION: "directors-bot-confirmation",
  KV: { get: async () => DIRECTORS_CHANNEL_ID },
} as unknown as Env;

const interaction = (over: Partial<Interaction> = {}): Interaction =>
  ({
    id: "1",
    type: 2,
    token: "t",
    application_id: "a",
    guild_id: "dance",
    channel_id: DIRECTORS_CHANNEL_ID,
    member: { roles: ["director-role"] },
    ...over,
  }) as Interaction;

describe("declineReason", () => {
  it("lets a director through in the right channel", async () => {
    expect(await declineReason(env, interaction(), env.CH_DIRECTORS_CONFIRMATION)).toBeNull();
  });

  it("declines someone without the director role", async () => {
    const reason = await declineReason(
      env,
      interaction({ member: { roles: ["member"] } }),
      env.CH_DIRECTORS_CONFIRMATION,
    );
    expect(reason).toBe("That command is directors only.");
  });

  it("declines a member carrying no roles at all", async () => {
    const reason = await declineReason(env, interaction({ member: {} }), env.CH_DIRECTORS_CONFIRMATION);
    expect(reason).toBe("That command is directors only.");
  });

  it("declines outside the dance guild", async () => {
    const reason = await declineReason(
      env,
      interaction({ guild_id: "community" }),
      env.CH_DIRECTORS_CONFIRMATION,
    );
    expect(reason).toContain("dance server");
  });

  it("declines outside the allowed channel", async () => {
    const reason = await declineReason(
      env,
      interaction({ channel_id: "999" }),
      env.CH_DIRECTORS_CONFIRMATION,
    );
    expect(reason).toContain("directors-bot-confirmation");
  });

  it("refuses rather than allowing when no director role is configured", async () => {
    const unconfigured = { ...env, ROLE_DIRECTOR_ID: "" } as Env;
    const reason = await declineReason(unconfigured, interaction(), env.CH_DIRECTORS_CONFIRMATION);
    expect(reason).toContain("Refusing");
  });
});
