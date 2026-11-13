import { beforeEach, describe, expect, it, vi } from "vitest";

const { alertDirectors } = vi.hoisted(() => ({
  alertDirectors: vi.fn(async (_env: unknown, _content: string): Promise<void> => undefined),
}));

vi.mock("../src/discord/rest", () => ({ alertDirectors }));

import { runPieceReview } from "../src/diamonds/pieceReview";
import type { Env } from "../src/env";

function envWith(seed: Record<string, string> = {}): Env {
  const store = new Map(Object.entries(seed));
  return {
    KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    },
  } as unknown as Env;
}

const ON = { "config:features.diamonds": "true" };

function said(): string {
  const calls = alertDirectors.mock.calls;
  return calls[calls.length - 1]![1];
}

beforeEach(() => {
  alertDirectors.mockReset();
  alertDirectors.mockResolvedValue(undefined);
});

describe("the twice-yearly group piece review", () => {
  it("says nothing while the flag is off", async () => {
    expect(await runPieceReview(envWith(), new Date("2027-01-01T09:00:00Z"))).toEqual({
      skipped: "flag_off",
    });
    expect(alertDirectors).not.toHaveBeenCalled();
  });

  it("asks them to decide in mid-December and mid-June", async () => {
    for (const [day, expected] of [
      ["2026-12-15T09:00:00Z", "think:2026-12"],
      ["2027-06-15T09:00:00Z", "think:2027-06"],
    ] as const) {
      expect(await runPieceReview(envWith(ON), new Date(day))).toEqual({ reminded: [expected] });
    }
  });

  /** The same halves of the year as membership enforcement, on purpose. */
  it("asks them to put it up on the first of January and of July", async () => {
    for (const [day, expected] of [
      ["2027-01-01T09:00:00Z", "act:2027-01"],
      ["2027-07-01T09:00:00Z", "act:2027-07"],
    ] as const) {
      expect(await runPieceReview(envWith(ON), new Date(day))).toEqual({ reminded: [expected] });
    }
  });

  it("is quiet the rest of the year", async () => {
    const env = envWith(ON);
    for (const quiet of [
      "2026-11-15T09:00:00Z",
      "2027-02-01T09:00:00Z",
      "2027-04-15T09:00:00Z",
      "2027-08-01T09:00:00Z",
    ]) {
      expect(await runPieceReview(env, new Date(quiet))).toEqual({});
    }
    expect(alertDirectors).not.toHaveBeenCalled();
  });

  /**
   * December's decide-it and January's do-it are different years, which the
   * occurrence label has to keep apart or the second looks already sent.
   */
  it("carries both stages across the new year", async () => {
    const env = envWith(ON);
    expect(await runPieceReview(env, new Date("2026-12-15T09:00:00Z"))).toEqual({
      reminded: ["think:2026-12"],
    });
    expect(await runPieceReview(env, new Date("2026-12-20T09:00:00Z"))).toEqual({});
    expect(await runPieceReview(env, new Date("2027-01-01T09:00:00Z"))).toEqual({
      reminded: ["act:2027-01"],
    });
    expect(alertDirectors).toHaveBeenCalledTimes(2);
  });

  it("still goes out inside the week after", async () => {
    expect(await runPieceReview(envWith(ON), new Date("2027-01-06T09:00:00Z"))).toEqual({
      reminded: ["act:2027-01"],
    });
    expect(await runPieceReview(envWith(ON), new Date("2027-01-09T09:00:00Z"))).toEqual({});
  });

  /**
   * The do-it message has to be runnable and has to be honest about its reach:
   * nothing stores a current piece, so a later Round 1 pass still needs
   * assigning by hand.
   */
  it("names the command and what it doesn't cover", async () => {
    await runPieceReview(envWith(ON), new Date("2027-01-01T09:00:00Z"));
    expect(said()).toMatch(/\/diamonds assign-all round:2/);
    expect(said()).toMatch(/hasn't started Round 2/);
    expect(said()).toMatch(/doesn't stick/);
    expect(said()).toMatch(/\/diamonds assign\b/);
  });

  it("tells them to decide now and put it up later", async () => {
    await runPieceReview(envWith(ON), new Date("2026-12-15T09:00:00Z"));
    expect(said()).toMatch(/Nothing to do yet/);
    expect(said()).not.toMatch(/assign-all/);
  });
});
