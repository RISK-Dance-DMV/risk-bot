import { describe, expect, it } from "vitest";
import {
  CYCLE_FOCUSES,
  cycleIdFor,
  isCycleFocus,
  cycleName,
  auditionWindow,
  cycleRangeFor,
  formatCycleDate,
  isOverdueToClose,
  needsNextCyclePrompt,
  nextBlockAfter,
  parseSessionLines,
  sessionSpan,
  saturdaysBetween,
  validateCycleDates,
  type CycleRecord,
} from "../src/cycles/cycle";
import {
  cycleCustomId,
  MAX_POLL_DATES,
  pollResultLines,
  parseCycleCustomId,
} from "../src/cycles/cycleFlow";
import { CYCLE_COMMAND } from "../src/commands/definitions";

const cycle = (over: Partial<CycleRecord> = {}): CycleRecord => ({
  cycleId: "2026-sep-oct",
  name: "SEP–OCT 2026",
  startsOn: "2026-09-01",
  endsOn: "2026-10-31",
  status: "active",
  ...over,
});

describe("nextBlockAfter", () => {
  it("walks the two-month sequence", () => {
    expect(nextBlockAfter("2026-01-01")).toEqual({
      startsOn: "2026-03-01",
      endsOn: "2026-04-30",
    });
    expect(nextBlockAfter("2026-05-01")).toEqual({
      startsOn: "2026-07-01",
      endsOn: "2026-08-31",
    });
  });

  /** The gap everyone gets wrong from memory. */
  it("skips Nov/Dec, rolling Sep/Oct straight into January", () => {
    expect(nextBlockAfter("2026-09-01")).toEqual({
      startsOn: "2027-01-01",
      endsOn: "2027-02-28",
    });
  });

  it("lands February on the 29th in a leap year", () => {
    expect(nextBlockAfter("2027-09-01")?.endsOn).toBe("2028-02-29");
  });

  /** A block ending in a 30-day month must not claim a 31st. */
  it("ends a block on the real last day of its month", () => {
    expect(nextBlockAfter("2026-03-01")?.endsOn).toBe("2026-06-30");
  });

  it("refuses a date it can't read", () => {
    expect(nextBlockAfter("not a date")).toBeNull();
  });
});

describe("naming", () => {
  it("reads as a range", () => {
    expect(cycleName("2026-09-01")).toBe("SEP–OCT 2026");
    expect(cycleName("2027-01-01")).toBe("JAN–FEB 2027");
  });

  it("makes an id that sorts and reads", () => {
    expect(cycleIdFor("2026-09-01")).toBe("2026-sep-oct");
  });
});

describe("saturdaysBetween", () => {
  it("finds every Saturday in the block", () => {
    const saturdays = saturdaysBetween("2026-09-01", "2026-10-31");
    expect(saturdays[0]).toBe("2026-09-05");
    expect(saturdays.at(-1)).toBe("2026-10-31");
  });

  /** A native Discord poll caps at 10 answers; a two-month block never exceeds 9. */
  it("never exceeds what a Discord poll can offer", () => {
    for (const start of ["2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01", "2026-09-01"]) {
      const block = nextBlockAfter(start);
      if (!block) throw new Error("no block");
      expect(saturdaysBetween(block.startsOn, block.endsOn).length).toBeLessThanOrEqual(9);
    }
  });

  it("counts a Saturday that is itself the first day", () => {
    expect(saturdaysBetween("2026-08-01", "2026-08-08")).toEqual(["2026-08-01", "2026-08-08"]);
  });

  it("returns nothing for a backwards range", () => {
    expect(saturdaysBetween("2026-10-31", "2026-09-01")).toEqual([]);
  });
});

describe("formatCycleDate", () => {
  it("labels a date without involving a timezone", () => {
    expect(formatCycleDate("2026-09-05")).toBe("Sat 5 Sep");
  });
});

describe("needsNextCyclePrompt", () => {
  const DAYS = 21;

  it("stays quiet until three weeks out", () => {
    expect(needsNextCyclePrompt(cycle(), DAYS, new Date("2026-10-01T00:00:00Z"))).toBe(false);
  });

  it("fires once inside the window", () => {
    expect(needsNextCyclePrompt(cycle(), DAYS, new Date("2026-10-11T00:00:00Z"))).toBe(true);
  });

  /** A coach who hasn't answered doesn't need asking again every morning. */
  it("fires only once", () => {
    const prompted = cycle({ nextPromptedAt: "2026-10-11T00:00:00Z" });
    expect(needsNextCyclePrompt(prompted, DAYS, new Date("2026-10-20T00:00:00Z"))).toBe(false);
  });

  it("ignores a cycle that isn't running", () => {
    for (const status of ["polling", "scheduling", "closed"] as const) {
      expect(
        needsNextCyclePrompt(cycle({ status }), DAYS, new Date("2026-10-20T00:00:00Z")),
      ).toBe(false);
    }
  });

  /**
   * Counted back from this cycle's end rather than forward from a stored
   * sequence position, so a cycle that was stretched or cut short still
   * prompts at the right time.
   */
  it("follows a cycle that was moved", () => {
    const stretched = cycle({ endsOn: "2026-12-15" });
    expect(needsNextCyclePrompt(stretched, DAYS, new Date("2026-10-20T00:00:00Z"))).toBe(false);
    expect(needsNextCyclePrompt(stretched, DAYS, new Date("2026-11-25T00:00:00Z"))).toBe(true);
  });
});

describe("isOverdueToClose", () => {
  it("is false on the last day", () => {
    expect(isOverdueToClose(cycle(), new Date("2026-10-31T12:00:00Z"))).toBe(false);
  });

  it("is true once it's properly past", () => {
    expect(isOverdueToClose(cycle(), new Date("2026-11-03T00:00:00Z"))).toBe(true);
  });

  it("ignores one that's already closed", () => {
    expect(isOverdueToClose(cycle({ status: "closed" }), new Date("2027-01-01T00:00:00Z"))).toBe(
      false,
    );
  });
});

describe("validateCycleDates", () => {
  it("accepts a normal block", () => {
    expect(validateCycleDates("2026-09-01", "2026-10-31")).toEqual({
      ok: true,
      startsOn: "2026-09-01",
      endsOn: "2026-10-31",
    });
  });

  /** The bootstrap exists for abnormal cycles, so an odd length is allowed. */
  it("accepts a cycle that isn't two clean months", () => {
    expect(validateCycleDates("2026-09-12", "2026-11-08").ok).toBe(true);
  });

  it("rejects an end before the start", () => {
    const result = validateCycleDates("2026-10-31", "2026-09-01");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("after the start");
  });

  it("rejects something implausibly long, which is usually a typo", () => {
    expect(validateCycleDates("2026-01-01", "2027-06-01").ok).toBe(false);
  });

  it("rejects a date it can't read", () => {
    expect(validateCycleDates("Sept 1", "2026-10-31").ok).toBe(false);
  });
});

describe("cycle custom ids", () => {
  it("round-trips inside Discord's 100-char cap", () => {
    const id = cycleCustomId("post", "2027-jan-feb");
    expect(parseCycleCustomId(id)).toEqual({ action: "post", cycleId: "2027-jan-feb" });
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it("ignores ids belonging to other features", () => {
    expect(parseCycleCustomId("aud|approve|abcdef")).toBeNull();
    expect(parseCycleCustomId("app|vote|12")).toBeNull();
    expect(parseCycleCustomId("cyc|nonsense|2027-jan-feb")).toBeNull();
    expect(parseCycleCustomId("cyc|post")).toBeNull();
  });

  /** The id is a cycle name, so hyphens have to survive the split. */
  it("keeps a hyphenated cycle id intact", () => {
    expect(parseCycleCustomId("cyc|dates-save|2027-jan-feb")?.cycleId).toBe("2027-jan-feb");
  });
});

describe("the poll's answer budget", () => {
  /**
   * Discord allows 10 answers and "None of these" takes one, so 9 dates is the
   * ceiling — which is exactly what a two-month block can contain.
   */
  it("leaves room for the none-of-these answer", () => {
    expect(MAX_POLL_DATES).toBe(9);
    for (const start of ["2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01", "2026-09-01"]) {
      const block = nextBlockAfter(start);
      if (!block) throw new Error("no block");
      const dates = saturdaysBetween(block.startsOn, block.endsOn);
      expect(dates.length + 1).toBeLessThanOrEqual(10);
    }
  });
});

describe("parseSessionLines", () => {
  it("takes a date on its own and fills in the standard time", () => {
    const result = parseSessionLines("2026-09-06");
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.sessions[0]).toEqual({ date: "2026-09-06", start: "10:15", end: "12:15" });
    }
  });

  /** A reaction poll gives counts and no names, which is what RISK actually has. */
  it("takes a bare headcount after the pipe", () => {
    const result = parseSessionLines("2026-09-06 11:00-13:00 | 5");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions[0]).toEqual({
      date: "2026-09-06",
      start: "11:00",
      end: "13:00",
      votes: 5,
    });
  });

  it("takes names instead, and counts them", () => {
    const result = parseSessionLines("2026-09-06 11:00-13:00 | Mimi, Tay, Avi");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions[0]?.attendees).toEqual(["Mimi", "Tay", "Avi"]);
    expect(result.sessions[0]?.votes).toBe(3);
  });

  it("sorts by date whatever order they were typed in", () => {
    const result = parseSessionLines("2026-10-03\n2026-09-06");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions.map((s) => s.date)).toEqual(["2026-09-06", "2026-10-03"]);
  });

  it("names the line it couldn't read", () => {
    const result = parseSessionLines("2026-09-06\nSept 12th");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("Sept 12th");
  });

  it("rejects a time range that ends before it starts", () => {
    expect(parseSessionLines("2026-09-06 13:00-11:00").ok).toBe(false);
  });

  it("rejects the same date twice", () => {
    const result = parseSessionLines("2026-09-06\n2026-09-06 11:00-13:00");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("twice");
  });

  it("rejects an empty schedule", () => {
    expect(parseSessionLines("   \n  ").ok).toBe(false);
  });

  /** The real thing: seven sessions off a reaction poll, Sundays included. */
  it("handles a whole cycle, including the non-Saturdays", () => {
    const result = parseSessionLines(
      [
        "2026-09-06 11:00-13:00 | 5",
        "2026-09-12 11:00-13:00 | 9",
        "2026-09-19 11:00-13:00 | 8",
        "2026-09-26 11:00-13:00 | 8",
        "2026-10-03 11:00-13:00 | 7",
        "2026-10-10 11:00-13:00 | 7",
        "2026-10-11 11:00-13:00 | 6",
      ].join("\n"),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions).toHaveLength(7);
    expect(sessionSpan(result.sessions)).toEqual({
      startsOn: "2026-09-06",
      endsOn: "2026-10-11",
    });
  });
});

describe("who's leading each session", () => {
  it("takes a lead after the times", () => {
    const result = parseSessionLines("2026-09-06 11:00-13:00 Ashna | Mimi, Tay");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions[0]).toMatchObject({
      date: "2026-09-06",
      start: "11:00",
      end: "13:00",
      lead: "Ashna",
      attendees: ["Mimi", "Tay"],
    });
  });

  /** Times are optional, so the field after the date is decided by shape. */
  it("takes a lead with the times left off", () => {
    const result = parseSessionLines("2026-09-06 Alina");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions[0]).toMatchObject({ lead: "Alina", start: "10:15" });
  });

  it("keeps a mention as a mention, so Discord renders it", () => {
    const result = parseSessionLines("2026-09-06 11:00-13:00 <@123> | 5");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions[0]?.lead).toBe("<@123>");
  });

  it("takes a name with a space in it", () => {
    const result = parseSessionLines("2026-09-06 11:00-13:00 Ashna Vayalil | 5");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions[0]?.lead).toBe("Ashna Vayalil");
  });

  it("records no lead when none is given", () => {
    const result = parseSessionLines("2026-09-06 11:00-13:00 | 5");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions[0]?.lead).toBeUndefined();
  });

  /**
   * A mistyped time range starts with a digit, which would otherwise be read
   * as somebody's name and silently give the session the default times.
   */
  it("calls out a mistyped time range instead of treating it as a name", () => {
    const result = parseSessionLines("2026-09-06 11-1pm | 5");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("isn't a time range");
  });

  it("accepts a single-digit hour", () => {
    const result = parseSessionLines("2026-09-06 9:00-11:00");
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessions[0]).toMatchObject({ start: "09:00", end: "11:00" });
  });
});

describe("cycle focus", () => {
  it("is exactly the five", () => {
    expect(CYCLE_FOCUSES).toEqual([
      "Isolations & Body Control",
      "Power & Dynamics",
      "Lines & Pictures",
      "Groove",
      "Footwork",
    ]);
  });

  it("accepts one of them and nothing else", () => {
    expect(isCycleFocus("Footwork")).toBe(true);
    expect(isCycleFocus("Isolations & Body Control")).toBe(true);
    expect(isCycleFocus("footwork")).toBe(false);
    expect(isCycleFocus("Freestyle")).toBe(false);
    expect(isCycleFocus("")).toBe(false);
  });

  /** Discord caps a select at 25 options, and a command choice list likewise. */
  it("fits in a select and a choice list", () => {
    expect(CYCLE_FOCUSES.length).toBeLessThanOrEqual(25);
  });
});

describe("the /cycle subcommands", () => {
  const names = (CYCLE_COMMAND.options as readonly { name: string }[]).map((o) => o.name);

  /**
   * Two ways in, on purpose: ask the trainees, or record what was already
   * decided. Both end at a schedule with dates, times and who's coming.
   */
  it("offers an automatic and a manual route to a schedule", () => {
    expect(names).toContain("poll");
    expect(names).toContain("schedule");
  });

  it("keeps the bootstrap and the close alongside them", () => {
    expect(names).toContain("start");
    expect(names).toContain("close");
  });

  /**
   * Without this the only way past a finished cycle was deleting KV keys,
   * because /cycle start refuses while one is open.
   */
  it("has a way to finish a cycle", () => {
    expect(names).toContain("close");
  });

  /** The import hatch is gone; nothing should re-add it by accident. */
  it("no longer carries the one-off poll import", () => {
    expect(names).not.toContain("link-poll");
  });

  /**
   * Two different closes, and confusing them is expensive: one ends the poll
   * and reports, the other cancels the cycle.
   */
  it("separates ending the poll from ending the cycle", () => {
    expect(names).toContain("poll-close");
    expect(names).toContain("close");
  });

  it("stays inside Discord's 25-subcommand cap", () => {
    expect(names.length).toBeLessThanOrEqual(25);
  });
});

describe("pollResultLines", () => {
  const results = [
    { date: "2027-01-02", names: ["Mimi", "Tay"] },
    { date: "2027-01-09", names: [] },
    { date: "2027-01-16", names: ["Avi"] },
  ];

  it("turns answers into schedule lines the coach can edit", () => {
    expect(pollResultLines(results, "11:00-13:00")).toBe(
      "2027-01-02 11:00-13:00 | Mimi, Tay\n2027-01-16 11:00-13:00 | Avi",
    );
  });

  /** A date nobody picked isn't a session. */
  it("drops a date nobody chose", () => {
    expect(pollResultLines(results, "11:00-13:00")).not.toContain("2027-01-09");
  });

  it("round-trips back through the session parser", () => {
    const parsed = parseSessionLines(pollResultLines(results, "11:00-13:00"));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0]).toMatchObject({
      date: "2027-01-02",
      start: "11:00",
      attendees: ["Mimi", "Tay"],
      votes: 2,
    });
  });

  it("is empty when nobody answered at all", () => {
    expect(pollResultLines([{ date: "2027-01-02", names: [] }], "11:00-13:00")).toBe("");
  });
});

describe("cycleRangeFor", () => {
  /** A learning week with no session is still part of the cycle. */
  it("keeps a declared start earlier than the first session", () => {
    expect(
      cycleRangeFor(
        { startsOn: "2026-08-29", endsOn: "2026-10-11" },
        { startsOn: "2026-09-06", endsOn: "2026-10-11" },
      ),
    ).toEqual({ startsOn: "2026-08-29", endsOn: "2026-10-11" });
  });

  it("extends for a session added past the declared end", () => {
    expect(
      cycleRangeFor(
        { startsOn: "2026-08-29", endsOn: "2026-10-11" },
        { startsOn: "2026-09-06", endsOn: "2026-10-25" },
      ),
    ).toEqual({ startsOn: "2026-08-29", endsOn: "2026-10-25" });
  });

  /**
   * The bug this fixes: a JAN–FEB cycle rescheduled onto September dates kept
   * its January header over a list of September sessions.
   */
  it("follows the sessions when they move outside the declared range entirely", () => {
    expect(
      cycleRangeFor(
        { startsOn: "2027-01-16", endsOn: "2027-02-20" },
        { startsOn: "2026-09-06", endsOn: "2026-10-11" },
      ),
    ).toEqual({ startsOn: "2026-09-06", endsOn: "2026-10-11" });
  });

  it("counts a single shared day as overlapping", () => {
    expect(
      cycleRangeFor(
        { startsOn: "2026-09-01", endsOn: "2026-09-06" },
        { startsOn: "2026-09-06", endsOn: "2026-10-11" },
      ),
    ).toEqual({ startsOn: "2026-09-01", endsOn: "2026-10-11" });
  });
});

describe("declared cycle dates", () => {
  const declared = { startsOn: "2026-08-29", endsOn: "2026-10-11" };
  const span = { startsOn: "2026-09-06", endsOn: "2026-10-11" };

  /**
   * The learning week. Editing the schedule is not a claim about when the
   * cycle began, so a stated start is never recomputed away.
   */
  it("keeps a stated start even when the sessions move entirely", () => {
    expect(cycleRangeFor(declared, { startsOn: "2027-01-02", endsOn: "2027-02-20" }, true)).toEqual(
      { startsOn: "2026-08-29", endsOn: "2027-02-20" },
    );
  });

  it("still widens for a session outside the stated range", () => {
    expect(cycleRangeFor(declared, { startsOn: "2026-08-22", endsOn: "2026-10-25" }, true)).toEqual(
      { startsOn: "2026-08-22", endsOn: "2026-10-25" },
    );
  });

  it("leaves a stated range alone when the sessions sit inside it", () => {
    expect(cycleRangeFor(declared, span, true)).toEqual(declared);
  });
});

describe("auditionWindow", () => {
  it("counts back from the end of the cycle", () => {
    expect(auditionWindow({ endsOn: "2026-10-11" }, 35, 14)).toEqual({
      opensOn: "2026-09-06",
      closesOn: "2026-09-27",
    });
  });

  it("returns nothing for an unreadable end date", () => {
    expect(auditionWindow({ endsOn: "soon" }, 35, 14)).toBeNull();
  });

  /** Opening before closing is the whole point; a bad config shouldn't invert it. */
  it("opens before it closes", () => {
    const window = auditionWindow({ endsOn: "2027-02-28" }, 35, 14);
    expect(window?.opensOn.localeCompare(window?.closesOn ?? "")).toBeLessThan(0);
  });
});
