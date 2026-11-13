import { beforeEach, describe, expect, it, vi } from "vitest";

const { alertDirectors } = vi.hoisted(() => ({
  alertDirectors: vi.fn(async (_env: unknown, _content: string): Promise<void> => undefined),
}));

vi.mock("../src/discord/rest", () => ({ alertDirectors }));

import { runFormReview } from "../src/applications/formReview";
import type { Env } from "../src/env";

function envWith(seed: Record<string, string> = {}): { env: Env; store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  const env = {
    KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    },
  } as unknown as Env;
  return { env, store };
}

/** The flag the rest of the applications jobs read. */
const ON = { "config:features.applications": "true" };

/** What the latest call said. */
function said(): string {
  const calls = alertDirectors.mock.calls;
  return calls[calls.length - 1]![1];
}

beforeEach(() => {
  alertDirectors.mockReset();
  alertDirectors.mockResolvedValue(undefined);
});

describe("the twice-yearly form review", () => {
  it("says nothing while the flag is off", async () => {
    const { env } = envWith();
    expect(await runFormReview(env, new Date("2026-11-15T09:00:00Z"))).toEqual({
      skipped: "flag_off",
    });
    expect(alertDirectors).not.toHaveBeenCalled();
  });

  it("asks them to decide in mid-November and mid-May", async () => {
    for (const [day, expected] of [
      ["2026-11-15T09:00:00Z", "think:2026-11"],
      ["2027-05-15T09:00:00Z", "think:2027-05"],
    ] as const) {
      const { env } = envWith(ON);
      expect(await runFormReview(env, new Date(day))).toEqual({ reminded: [expected] });
    }
  });

  it("asks them to do it on the first of December and of June", async () => {
    for (const [day, expected] of [
      ["2026-12-01T09:00:00Z", "act:2026-12"],
      ["2027-06-01T09:00:00Z", "act:2027-06"],
    ] as const) {
      const { env } = envWith(ON);
      expect(await runFormReview(env, new Date(day))).toEqual({ reminded: [expected] });
    }
  });

  it("is quiet the rest of the year", async () => {
    const { env } = envWith(ON);
    for (const quiet of [
      "2026-10-15T09:00:00Z",
      "2027-01-15T09:00:00Z",
      "2027-03-01T09:00:00Z",
      "2027-07-20T09:00:00Z",
    ]) {
      expect(await runFormReview(env, new Date(quiet))).toEqual({});
    }
    expect(alertDirectors).not.toHaveBeenCalled();
  });

  /**
   * Useful late, useless never. A cron that missed the 15th because the Worker
   * was down should still say something on the Monday — unlike a deadline
   * warning, where arriving late is worse than silence.
   */
  it("still goes out inside the week after", async () => {
    const { env } = envWith(ON);
    expect(await runFormReview(env, new Date("2026-11-20T09:00:00Z"))).toEqual({
      reminded: ["think:2026-11"],
    });

    const { env: late } = envWith(ON);
    expect(await runFormReview(late, new Date("2026-11-23T09:00:00Z"))).toEqual({});
  });

  it("goes once per stage per occurrence, and again six months later", async () => {
    const { env } = envWith(ON);
    expect(await runFormReview(env, new Date("2026-11-15T09:00:00Z"))).toEqual({
      reminded: ["think:2026-11"],
    });
    // Same occurrence, next morning: nothing.
    expect(await runFormReview(env, new Date("2026-11-16T09:00:00Z"))).toEqual({});
    expect(alertDirectors).toHaveBeenCalledTimes(1);

    // The second stage is its own marker, so it still fires.
    expect(await runFormReview(env, new Date("2026-12-01T09:00:00Z"))).toEqual({
      reminded: ["act:2026-12"],
    });
    // And round again in May and June.
    expect(await runFormReview(env, new Date("2027-05-15T09:00:00Z"))).toEqual({
      reminded: ["think:2027-05"],
    });
    expect(await runFormReview(env, new Date("2027-06-01T09:00:00Z"))).toEqual({
      reminded: ["act:2027-06"],
    });
    expect(alertDirectors).toHaveBeenCalledTimes(4);
  });

  /**
   * The mechanical half of the message, and it belongs on the stage that lands
   * when someone is about to edit. Reviewing the forms is judgement nobody can
   * automate; the columns trap is a fact, and it's the reason this fires
   * *before* anyone edits anything rather than after.
   */
  it("carries the columns warning on the day they change it", async () => {
    const { env } = envWith(ON);
    await runFormReview(env, new Date("2026-12-01T09:00:00Z"));
    expect(said()).toMatch(/application form/);
    expect(said()).toMatch(/audition form/);
    expect(said()).toMatch(/src\/config\/columns\.ts/);
    expect(said()).toMatch(/read by column/);
  });

  /** And the earlier one tells them not to edit yet, which is the whole point. */
  it("tells them to decide now and edit later", async () => {
    const { env } = envWith(ON);
    await runFormReview(env, new Date("2026-11-15T09:00:00Z"));
    expect(said()).toMatch(/Nothing to do yet/);
    expect(said()).toMatch(/still open/);
  });
});
