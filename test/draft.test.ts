import { describe, expect, it } from "vitest";
import {
  CONTENT_LIMIT,
  describeConfirmation,
  describeTarget,
  draftCustomId,
  isDueForReping,
  parseDraftCustomId,
  renderDraft,
  renderResolvedDraft,
  validateContent,
  type Draft,
} from "../src/drafts/draft";
import type { MessagePayload } from "../src/discord/types";

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: "a1b2c3d4e5f6",
  kind: "cycle announcement",
  state: "pending",
  content: "JUN–JUL starts Saturday.\nBring water.",
  target: { kind: "channel", guild: "dance", channel: "announcements" },
  confirmation: { guild: "dance", channel: "coaches-bot-confirmation" },
  createdAt: "2026-09-01T00:00:00Z",
  ...over,
});

const buttonIds = (msg: MessagePayload): string[] =>
  (msg.components as { components: { custom_id?: string }[] }[] | undefined)
    ?.flatMap((row) => row.components)
    .map((b) => b.custom_id ?? "") ?? [];

describe("draft custom ids", () => {
  it("round-trips, and stays short enough for Discord's 100-char cap", () => {
    const id = draftCustomId("approve", "a1b2c3d4e5f6");
    expect(parseDraftCustomId(id)).toEqual({ action: "approve", id: "a1b2c3d4e5f6" });
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it("covers every action", () => {
    for (const action of ["approve", "edit", "skip", "edit-save"] as const) {
      expect(parseDraftCustomId(draftCustomId(action, "abcdef"))?.action).toBe(action);
    }
  });

  it("ignores ids belonging to other features", () => {
    expect(parseDraftCustomId("app|open|12")).toBeNull();
    expect(parseDraftCustomId("draft|publish|abcdef")).toBeNull();
    expect(parseDraftCustomId("draft|approve|BAD-ID")).toBeNull();
    expect(parseDraftCustomId("draft|approve")).toBeNull();
  });
});

describe("describeConfirmation", () => {
  /**
   * A link rather than "in this thread": the button is usually clicked from the
   * channel, where the thread is a collapsed line under the card at best.
   */
  it("links the thread when that's where the draft landed", () => {
    const d = draft({ channelId: "999", messageId: "1" });
    expect(describeConfirmation(d, "999")).toBe("in <#999>");
  });

  it("names the channel when there is no thread", () => {
    const d = draft({ channelId: "555" });
    expect(describeConfirmation(d)).toBe("in #coaches-bot-confirmation");
  });

  /**
   * The case worth pinning: the thread post failed and createDraft fell back,
   * so the card has a threadId but the draft isn't in it. Pointing a director
   * at an empty thread is worse than not offering the shortcut.
   */
  it("names the channel when the thread post fell back", () => {
    const d = draft({ channelId: "555" });
    expect(describeConfirmation(d, "999")).toBe("in #coaches-bot-confirmation");
  });

  it("names the channel for a draft that hasn't been posted yet", () => {
    expect(describeConfirmation(draft(), "999")).toBe("in #coaches-bot-confirmation");
  });
});

describe("validateContent", () => {
  it("rejects an empty draft", () => {
    expect(validateContent("   ")).toContain("empty");
  });

  it("rejects a draft past what Discord will publish", () => {
    expect(validateContent("x".repeat(CONTENT_LIMIT + 1))).toContain("cap");
  });

  it("accepts an ordinary draft", () => {
    expect(validateContent("Practice moved to 11am.")).toBeNull();
  });
});

describe("renderDraft", () => {
  it("offers approve, edit and skip", () => {
    expect(buttonIds(renderDraft(draft()))).toEqual([
      "draft|approve|a1b2c3d4e5f6",
      "draft|edit|a1b2c3d4e5f6",
      "draft|skip|a1b2c3d4e5f6",
    ]);
  });

  it("names where an approval would publish to", () => {
    expect(renderDraft(draft()).content).toContain("#announcements");
  });

  it("quotes the draft so it doesn't read as the bot talking", () => {
    const content = renderDraft(draft()).content ?? "";
    expect(content).toContain("> JUN–JUL starts Saturday.");
    expect(content).toContain("> Bring water.");
  });

  it("shows the date it references when there is one", () => {
    const content = renderDraft(draft({ referencesAt: "2026-09-12T00:00:00Z" })).content ?? "";
    expect(content).toContain("References <t:");
  });

  it("pings nobody", () => {
    expect(renderDraft(draft()).allowed_mentions).toEqual({ parse: [] });
  });
});

describe("renderResolvedDraft", () => {
  const published = draft({
    state: "published",
    publishedAs: "verbatim",
    actedBy: "d1",
    publishedChannelId: "777",
    publishedMessageId: "888",
  });

  it("drops the buttons once actioned", () => {
    expect(renderResolvedDraft(published, "g1").components).toEqual([]);
  });

  it("records who published it and links the result", () => {
    const content = renderResolvedDraft(published, "g1").content ?? "";
    expect(content).toContain("published verbatim by <@d1>");
    expect(content).toContain("https://discord.com/channels/g1/777/888");
  });

  it("distinguishes an edited publish", () => {
    const content =
      renderResolvedDraft({ ...published, publishedAs: "edited" }, "g1").content ?? "";
    expect(content).toContain("with edits");
  });

  it("says plainly that a skip published nothing", () => {
    const content =
      renderResolvedDraft(draft({ state: "skipped", actedBy: "d2" }), "g1").content ?? "";
    expect(content).toContain("skipped by <@d2>");
    expect(content).toContain("Nothing was published");
    expect(content).not.toContain("discord.com/channels");
  });
});

describe("isDueForReping", () => {
  const now = new Date("2026-09-10T00:00:00Z");
  const hours = 48;
  const at = (iso: string) => draft({ referencesAt: iso });

  it("fires inside the window", () => {
    expect(isDueForReping(at("2026-09-11T12:00:00Z"), now, hours)).toBe(true);
  });

  it("stays quiet outside it", () => {
    expect(isDueForReping(at("2026-09-12T12:00:00Z"), now, hours)).toBe(false);
  });

  it("still fires once the date has passed", () => {
    expect(isDueForReping(at("2026-09-01T00:00:00Z"), now, hours)).toBe(true);
  });

  it("re-pings once, not daily", () => {
    const already = draft({
      referencesAt: "2026-09-11T00:00:00Z",
      repingedAt: "2026-09-09T00:00:00Z",
    });
    expect(isDueForReping(already, now, hours)).toBe(false);
  });

  it("ignores drafts that were already actioned", () => {
    expect(
      isDueForReping(draft({ state: "published", referencesAt: "2026-09-11T00:00:00Z" }), now, hours),
    ).toBe(false);
  });

  it("ignores drafts with no date and unparseable ones", () => {
    expect(isDueForReping(draft(), now, hours)).toBe(false);
    expect(isDueForReping(at("not a date"), now, hours)).toBe(false);
  });
});

describe("email targets", () => {
  const emailDraft = (over: Partial<Draft> = {}) =>
    draft({
      kind: "interview invitation",
      target: { kind: "email", to: "mimi@example.com", subject: "RISK interview" },
      content: "Hi Mimi — can you do Saturday at 2pm?",
      ...over,
    });

  it("shows the recipient and subject so they're eyeballed before sending", () => {
    const content = renderDraft(emailDraft()).content ?? "";
    expect(content).toContain("mimi@example.com");
    expect(content).toContain("Subject: RISK interview");
    expect(content).not.toContain("Publishes to");
  });

  it("goes through the same three buttons as a channel post", () => {
    expect(buttonIds(renderDraft(emailDraft()))).toEqual([
      "draft|approve|a1b2c3d4e5f6",
      "draft|edit|a1b2c3d4e5f6",
      "draft|skip|a1b2c3d4e5f6",
    ]);
  });

  it("says sent, not published, once it goes", () => {
    const content =
      renderResolvedDraft(
        emailDraft({ state: "published", publishedAs: "verbatim", actedBy: "d1" }),
      ).content ?? "";
    expect(content).toContain("sent verbatim by <@d1>");
    expect(content).toContain("mimi@example.com");
    expect(content).not.toContain("discord.com/channels");
  });

  it("reports a skipped send as nothing sent", () => {
    const content =
      renderResolvedDraft(emailDraft({ state: "skipped", actedBy: "d2" })).content ?? "";
    expect(content).toContain("Nothing was sent");
  });
});

describe("describeTarget", () => {
  it("names a channel with a hash and an email with the address", () => {
    expect(describeTarget({ kind: "channel", guild: "dance", channel: "announcements" })).toBe(
      "#announcements",
    );
    expect(describeTarget({ kind: "email", to: "a@b.com", subject: "x" })).toBe("a@b.com");
  });
});
