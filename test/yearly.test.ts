import { beforeEach, describe, expect, it, vi } from "vitest";

const { alertDirectors } = vi.hoisted(() => ({
  alertDirectors: vi.fn(async (_env: unknown, _content: string): Promise<void> => undefined),
}));

vi.mock("../src/discord/rest", () => ({ alertDirectors }));

import { dueOccurrence, runYearlyReminders, type YearlyStage } from "../src/config/yearly";
import type { Env } from "../src/env";

function envWith(): Env {
  const store = new Map<string, string>();
  return {
    KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    },
  } as unknown as Env;
}

beforeEach(() => {
  alertDirectors.mockReset();
  alertDirectors.mockResolvedValue(undefined);
});

describe("dueOccurrence", () => {
  const days = [{ month: 10, day: 15 }] as const;

  it("labels by year and month", () => {
    expect(dueOccurrence(days, new Date("2026-11-15T00:00:00Z"))).toBe("2026-11");
  });

  it("covers the day itself and the six after it", () => {
    expect(dueOccurrence(days, new Date("2026-11-14T23:59:59Z"))).toBeUndefined();
    expect(dueOccurrence(days, new Date("2026-11-21T23:59:59Z"))).toBe("2026-11");
    expect(dueOccurrence(days, new Date("2026-11-22T00:00:01Z"))).toBeUndefined();
  });

  it("takes the grace window as an argument", () => {
    expect(dueOccurrence(days, new Date("2026-11-16T00:00:00Z"), 1)).toBeUndefined();
    expect(dueOccurrence(days, new Date("2026-11-15T12:00:00Z"), 1)).toBe("2026-11");
  });
});

describe("runYearlyReminders", () => {
  /**
   * Neither real schedule puts two stages in the same week, so nothing else
   * exercises this — but a schedule that did would have dropped one silently
   * if the loop returned at the first match.
   */
  it("fires every stage that's due, not just the first", async () => {
    const stages: YearlyStage[] = [
      { name: "think", days: [{ month: 0, day: 1 }], message: "one" },
      { name: "act", days: [{ month: 0, day: 1 }], message: "two" },
    ];
    expect(await runYearlyReminders(envWith(), "subject", stages, new Date("2027-01-01T09:00:00Z")))
      .toEqual({ reminded: ["think:2027-01", "act:2027-01"] });
    expect(alertDirectors.mock.calls.map((call) => call[1])).toEqual(["one", "two"]);
  });

  it("keys the marker by subject and stage", async () => {
    const store = new Map<string, string>();
    const env = {
      KV: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => void store.set(key, value),
      },
    } as unknown as Env;
    const stages: YearlyStage[] = [
      { name: "think", days: [{ month: 0, day: 1 }], message: "one" },
    ];
    await runYearlyReminders(env, "subject", stages, new Date("2027-01-01T09:00:00Z"));
    expect([...store.keys()]).toEqual(["subject:think:2027-01"]);
  });

  it("says nothing when no stage is due", async () => {
    const stages: YearlyStage[] = [
      { name: "think", days: [{ month: 0, day: 1 }], message: "one" },
    ];
    expect(await runYearlyReminders(envWith(), "subject", stages, new Date("2027-03-01T09:00:00Z")))
      .toEqual({});
    expect(alertDirectors).not.toHaveBeenCalled();
  });
});
