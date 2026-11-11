import { describe, expect, it } from "vitest";
import {
  bookableSessions,
  costEstimate,
  daysWaiting,
  formatMoney,
  isBookable,
  validateBooking,
  windowOpensOn,
} from "../src/cycles/booking";
import { bookingWindowCard } from "../src/cycles/cycleFlow";
import type { CycleSession } from "../src/cycles/cycle";

const session = (over: Partial<CycleSession> = {}): CycleSession => ({
  date: "2026-10-31",
  start: "11:00",
  end: "13:00",
  ...over,
});

const LEAD = 30;

describe("windowOpensOn", () => {
  it("is thirty days before the session", () => {
    expect(windowOpensOn("2026-10-31", 30)).toBe("2026-10-01");
  });

  it("crosses a month boundary correctly", () => {
    expect(windowOpensOn("2027-01-02", 30)).toBe("2026-12-03");
  });

  it("returns nothing for a date it can't read", () => {
    expect(windowOpensOn("Saturday", 30)).toBeNull();
  });
});

describe("isBookable", () => {
  it("is false before the window opens", () => {
    expect(isBookable(session(), LEAD, new Date("2026-09-30T12:00:00Z"))).toBe(false);
  });

  it("is true on the day it opens", () => {
    expect(isBookable(session(), LEAD, new Date("2026-10-01T00:05:00Z"))).toBe(true);
  });

  it("stays true right up to the session itself", () => {
    expect(isBookable(session(), LEAD, new Date("2026-10-31T09:00:00Z"))).toBe(true);
  });

  /**
   * Nothing can be done about a session that's been and gone, and a list that
   * keeps naming them trains people to stop reading it.
   */
  it("is false once the day has passed", () => {
    expect(isBookable(session(), LEAD, new Date("2026-11-01T00:00:00Z"))).toBe(false);
  });

  it("is false once it's booked", () => {
    const booked = session({
      booking: {
        venue: "DL",
        room: "Studio 2",
        venueType: "studio",
        cost: 100,
        bookedBy: "c1",
        bookedAt: "2026-10-02T00:00:00Z",
      },
    });
    expect(isBookable(booked, LEAD, new Date("2026-10-05T00:00:00Z"))).toBe(false);
  });
});

describe("bookableSessions", () => {
  const sessions = [
    session({ date: "2026-11-14" }),
    session({ date: "2026-10-31" }),
    session({ date: "2026-12-05" }),
  ];

  it("lists what's open, earliest first", () => {
    const open = bookableSessions(sessions, LEAD, new Date("2026-10-20T00:00:00Z"));
    expect(open.map((s) => s.date)).toEqual(["2026-10-31", "2026-11-14"]);
  });

  it("is empty before any window opens", () => {
    expect(bookableSessions(sessions, LEAD, new Date("2026-09-01T00:00:00Z"))).toEqual([]);
  });

  /** A non-Saturday session crosses the line on its own schedule. */
  it("doesn't care which day of the week it is", () => {
    const sunday = [session({ date: "2026-10-11" })];
    expect(bookableSessions(sunday, LEAD, new Date("2026-09-12T00:00:00Z"))).toHaveLength(1);
  });
});

describe("costEstimate", () => {
  it("divides the room between the people expected", () => {
    expect(costEstimate(100, 7)).toBeCloseTo(14.2857);
    expect(formatMoney(costEstimate(100, 7) as number)).toBe("$14.29");
  });

  /** The doc wants "—" here; a confident wrong number is worse than none. */
  it("refuses to divide by an unknown", () => {
    expect(costEstimate(100, undefined)).toBeNull();
    expect(costEstimate(100, 0)).toBeNull();
  });

  it("gives zero for a free room, which is a real answer", () => {
    expect(costEstimate(0, 7)).toBe(0);
  });
});

describe("validateBooking", () => {
  const input = { venue: "DL", room: "Studio 2", venueType: "studio", cost: "100" };

  it("takes a normal booking", () => {
    const result = validateBooking(input);
    expect(result).toMatchObject({
      ok: true,
      booking: { venue: "DL", room: "Studio 2", venueType: "studio", cost: 100 },
    });
  });

  /** Completeness is what makes the split work — a free room still gets a row. */
  it("treats a blank cost as free rather than missing", () => {
    const result = validateBooking({ ...input, venueType: "free", cost: "" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.booking.cost).toBe(0);
  });

  it("tolerates a dollar sign", () => {
    const result = validateBooking({ ...input, cost: "$95.50" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.booking.cost).toBe(95.5);
  });

  it("refuses a venue type outside the three", () => {
    const result = validateBooking({ ...input, venueType: "church hall" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("library, studio, free");
  });

  it("refuses a cost that isn't a number", () => {
    expect(validateBooking({ ...input, cost: "about a hundred" }).ok).toBe(false);
    expect(validateBooking({ ...input, cost: "-20" }).ok).toBe(false);
  });

  it("refuses a booking with no venue", () => {
    expect(validateBooking({ ...input, venue: "  " }).ok).toBe(false);
  });
});

describe("daysWaiting", () => {
  it("counts from the day the window opened", () => {
    expect(daysWaiting(session(), LEAD, new Date("2026-10-04T00:00:00Z"))).toBe(3);
  });

  it("is zero on the day it opens", () => {
    expect(daysWaiting(session(), LEAD, new Date("2026-10-01T06:00:00Z"))).toBe(0);
  });
});

describe("the booking window card", () => {
  const cycle = {
    cycleId: "2026-sep-oct",
    name: "SEP–OCT 2026",
    startsOn: "2026-09-06",
    endsOn: "2026-10-31",
    status: "active" as const,
    sessions: [
      { date: "2026-10-31", start: "11:00", end: "13:00", votes: 7, lead: "Ashna" },
      { date: "2026-11-14", start: "11:00", end: "13:00" },
    ],
  };

  const card = (now: string) =>
    bookingWindowCard(
      cycle,
      bookableSessions(cycle.sessions, LEAD, new Date(now)),
      LEAD,
      new Date(now),
    ).content as string;

  it("names the session, the lead and how many are expected", () => {
    const text = card("2026-10-04T00:00:00Z");
    expect(text).toContain("Sat 31 Oct");
    expect(text).toContain("Ashna");
    expect(text).toContain("7 expected");
  });

  /** The doc's "—" where nobody is known, rather than a number from nothing. */
  it("says — when nobody has said they're coming", () => {
    const text = card("2026-10-20T00:00:00Z");
    expect(text).toContain("— expected");
  });

  it("says how long a session has been sitting unbooked", () => {
    expect(card("2026-10-04T00:00:00Z")).toContain("open 3d");
  });

  it("offers each open session to mark booked", () => {
    const msg = bookingWindowCard(
      cycle,
      bookableSessions(cycle.sessions, LEAD, new Date("2026-10-20T00:00:00Z")),
      LEAD,
      new Date("2026-10-20T00:00:00Z"),
    );
    const select = ((msg.components ?? []) as {
      components: { options?: { value: string }[] }[];
    }[])
      .flatMap((r) => r.components)
      .find((c) => c.options);
    expect(select?.options?.map((o) => o.value)).toEqual(["2026-10-31", "2026-11-14"]);
  });
});
