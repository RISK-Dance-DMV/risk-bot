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

  it("fires on 15 November and on 15 June, and nowhere else", async () => {
    for (const [day, expected] of [
      ["2026-11-15T09:00:00Z", "2026-11"],
      ["2027-06-15T09:00:00Z", "2027-06"],
    ] as const) {
      const { env } = envWith(ON);
      expect(await runFormReview(env, new Date(day))).toEqual({ reminded: expected });
    }

    alertDirectors.mockClear();
    const { env } = envWith(ON);
    for (const quiet of ["2026-10-15T09:00:00Z", "2026-12-15T09:00:00Z", "2027-03-01T09:00:00Z"]) {
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
      reminded: "2026-11",
    });

    const { env: late } = envWith(ON);
    expect(await runFormReview(late, new Date("2026-11-23T09:00:00Z"))).toEqual({});
  });

  it("goes once per occurrence, and again six months later", async () => {
    const { env } = envWith(ON);
    expect(await runFormReview(env, new Date("2026-11-15T09:00:00Z"))).toEqual({
      reminded: "2026-11",
    });
    // Same occurrence, next morning: nothing.
    expect(await runFormReview(env, new Date("2026-11-16T09:00:00Z"))).toEqual({});
    expect(alertDirectors).toHaveBeenCalledTimes(1);

    // June comes round and it's a different occurrence.
    expect(await runFormReview(env, new Date("2027-06-15T09:00:00Z"))).toEqual({
      reminded: "2027-06",
    });
    expect(alertDirectors).toHaveBeenCalledTimes(2);
  });

  /**
   * The mechanical half of the message. A reminder to review the forms is
   * judgement nobody can automate; the columns trap is a fact, and it's the
   * reason this fires *before* anyone edits anything rather than after.
   */
  it("names both forms and the columns file", async () => {
    const { env } = envWith(ON);
    await runFormReview(env, new Date("2026-11-15T09:00:00Z"));
    const said = alertDirectors.mock.calls[0]![1];
    expect(said).toMatch(/application form/);
    expect(said).toMatch(/audition form/);
    expect(said).toMatch(/src\/config\/columns\.ts/);
    expect(said).toMatch(/read by column/);
  });
});
