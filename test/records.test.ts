import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecord, putRecord, type CardRecord } from "../src/applications/intake";
import type { Env } from "../src/env";

/**
 * A KV double that goes stale exactly the way the real one can: writes land,
 * but reads keep returning the previous value until `settle()` is called.
 */
function staleKV(initial: Record<string, unknown> = {}) {
  let visible: Record<string, unknown> = { ...initial };
  let pending: Record<string, unknown> = { ...initial };
  return {
    kv: {
      get: async (key: string) => visible[key] ?? null,
      put: async (key: string, value: string) => {
        pending[key] = JSON.parse(value);
      },
    },
    settle: () => {
      visible = { ...pending };
    },
  };
}

const record = (row: number, text: string): CardRecord =>
  ({
    row,
    messageId: "m",
    channelId: "c",
    method: "video_submission",
    state: "open",
    waitingSince: "2026-09-01T00:00:00Z",
    decision: { ballots: {}, feedback: { d1: { text, at: "x" } } },
  }) as CardRecord;

describe("reading a card back after writing it", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns what was just written, even while KV is still stale", async () => {
    const { kv } = staleKV({ "app:carded:118": record(118, "meowwww") });
    const env = { KV: kv } as unknown as Env;

    await putRecord(env, record(118, "its ok"));
    const read = await getRecord(env, 118);
    expect(read?.decision?.feedback?.d1?.text).toBe("its ok");
  });

  it("goes back to KV once the staleness window has passed", async () => {
    const { kv, settle } = staleKV({ "app:carded:119": record(119, "old") });
    const env = { KV: kv } as unknown as Env;

    await putRecord(env, record(119, "mine"));
    settle();
    // Another isolate writes; ours must stop preferring its own copy.
    (kv as unknown as { get: (k: string) => Promise<unknown> }).get = async () =>
      record(119, "theirs");

    vi.advanceTimersByTime(61_000);
    expect((await getRecord(env, 119))?.decision?.feedback?.d1?.text).toBe("theirs");
  });

  it("keeps rows apart", async () => {
    const { kv } = staleKV({});
    const env = { KV: kv } as unknown as Env;

    await putRecord(env, record(117, "three"));
    await putRecord(env, record(118, "four"));
    expect((await getRecord(env, 117))?.decision?.feedback?.d1?.text).toBe("three");
    expect((await getRecord(env, 118))?.decision?.feedback?.d1?.text).toBe("four");
  });
});
