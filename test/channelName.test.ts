import { describe, expect, it } from "vitest";
import {
  matchChannel,
  normalizeChannelName,
  type ChannelLike,
} from "../src/discord/channelName";

const channels = (...names: string[]): ChannelLike[] =>
  names.map((name, i) => ({ id: String(100 + i), name }));

describe("normalizeChannelName", () => {
  it("strips a leading emoji and separator", () => {
    expect(normalizeChannelName("📋-directors-bot-confirmation")).toBe(
      "directors-bot-confirmation",
    );
    expect(normalizeChannelName("🎭┃audition-review")).toBe("audition-review");
    expect(normalizeChannelName("📋 audition-review")).toBe("audition-review");
  });

  it("strips trailing decoration too", () => {
    expect(normalizeChannelName("audition-review-✨")).toBe("audition-review");
  });

  it("leaves an undecorated name alone", () => {
    expect(normalizeChannelName("audition-review")).toBe("audition-review");
  });

  it("keeps hyphens and digits inside the name", () => {
    expect(normalizeChannelName("🔥winter-dance-dump-2")).toBe("winter-dance-dump-2");
  });

  it("lowercases", () => {
    expect(normalizeChannelName("Audition-Review")).toBe("audition-review");
  });
});

describe("matchChannel", () => {
  it("finds an exactly-named channel", () => {
    const match = matchChannel(channels("general", "audition-review"), "audition-review");
    expect(match).toEqual({ ok: true, id: "101", name: "audition-review" });
  });

  it("finds one that's been decorated with an emoji", () => {
    const match = matchChannel(channels("general", "📋┃audition-review"), "audition-review");
    expect(match).toMatchObject({ ok: true, name: "📋┃audition-review" });
  });

  it("prefers an exact match over a decorated one", () => {
    const match = matchChannel(
      channels("📋-audition-review", "audition-review"),
      "audition-review",
    );
    expect(match).toMatchObject({ ok: true, name: "audition-review" });
  });

  it("works when config carries the emoji and Discord doesn't", () => {
    const match = matchChannel(channels("audition-review"), "📋-audition-review");
    expect(match).toMatchObject({ ok: true, name: "audition-review" });
  });

  it("refuses rather than guessing between two decorated candidates", () => {
    const match = matchChannel(
      channels("📋-audition-review", "🎭-audition-review"),
      "audition-review",
    );
    expect(match.ok).toBe(false);
    if (!match.ok) {
      expect(match.reason).toContain("ambiguous");
      expect(match.reason).toContain("📋-audition-review");
    }
  });

  it("reports a genuinely missing channel", () => {
    const match = matchChannel(channels("general"), "audition-review");
    expect(match).toEqual({ ok: false, reason: "no channel matching #audition-review" });
  });

  it("doesn't match a different channel that merely looks similar", () => {
    expect(matchChannel(channels("audition-reviews"), "audition-review").ok).toBe(false);
  });

  it("rejects a config value that is nothing but decoration", () => {
    const match = matchChannel(channels("general"), "📋");
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.reason).toContain("usable channel name");
  });
});
