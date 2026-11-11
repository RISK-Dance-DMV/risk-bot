import { describe, expect, it } from "vitest";
import { dueReminders, reminderDue, remindOn } from "../src/cycles/reminders";
import { sessionReminderCard, videoReminderCard } from "../src/cycles/cycleFlow";
import type { CycleRecord, CycleSession } from "../src/cycles/cycle";

const session = (over: Partial<CycleSession> = {}): CycleSession => ({
  date: "2026-10-31",
  start: "11:00",
  end: "13:00",
  ...over,
});

const cycle: CycleRecord = {
  cycleId: "2026-sep-oct",
  name: "SEP–OCT 2026",
  startsOn: "2026-09-06",
  endsOn: "2026-10-31",
  status: "active",
  focus: "Footwork",
};

describe("remindOn", () => {
  it("counts back in whole days", () => {
    expect(remindOn("2026-10-31", 2)).toBe("2026-10-29");
    expect(remindOn("2026-10-31", 1)).toBe("2026-10-30");
  });

  it("crosses a month boundary", () => {
    expect(remindOn("2026-11-01", 2)).toBe("2026-10-30");
  });
});

describe("reminderDue", () => {
  it("fires on the day, not before", () => {
    expect(reminderDue(session(), "session", 2, new Date("2026-10-28T23:00:00Z"))).toBe(false);
    expect(reminderDue(session(), "session", 2, new Date("2026-10-29T08:00:00Z"))).toBe(true);
  });

  /**
   * Due *on* the day rather than from it onwards: a job that missed its window
   * should stay quiet rather than send "training in two days" the morning of.
   */
  it("doesn't fire late", () => {
    expect(reminderDue(session(), "session", 2, new Date("2026-10-31T08:00:00Z"))).toBe(false);
  });

  it("fires once", () => {
    const sent = session({ remindedSessionAt: "2026-10-29T08:00:00Z" });
    expect(reminderDue(sent, "session", 2, new Date("2026-10-29T18:00:00Z"))).toBe(false);
  });

  /** The two reminders are tracked separately, or the first would silence the second. */
  it("tracks the video reminder apart from the session one", () => {
    const sent = session({ remindedSessionAt: "2026-10-29T08:00:00Z" });
    expect(reminderDue(sent, "video", 1, new Date("2026-10-30T08:00:00Z"))).toBe(true);
  });
});

describe("dueReminders", () => {
  const sessions = [session({ date: "2026-11-07" }), session({ date: "2026-10-31" })];

  it("picks only the session whose day it is", () => {
    const due = dueReminders(sessions, "session", 2, new Date("2026-10-29T08:00:00Z"));
    expect(due.map((s) => s.date)).toEqual(["2026-10-31"]);
  });

  it("is empty on a quiet day", () => {
    expect(dueReminders(sessions, "session", 2, new Date("2026-10-20T08:00:00Z"))).toEqual([]);
  });
});

describe("the reminder messages", () => {
  it("says where, when, who's leading and the focus", () => {
    const text = sessionReminderCard(
      cycle,
      session({
        lead: "Ashna",
        attendees: ["Mimi", "Tay"],
        booking: {
          venue: "DL",
          room: "Studio 2",
          venueType: "studio",
          cost: 100,
          bookedBy: "c1",
          bookedAt: "x",
        },
      }),
    ).content as string;

    expect(text).toContain("Sat 31 Oct");
    expect(text).toContain("DL Studio 2");
    expect(text).toContain("Ashna");
    expect(text).toContain("Footwork");
    expect(text).toContain("Mimi, Tay");
  });

  /** Two days out with no room is exactly when someone needs to notice. */
  it("flags a session that still has no room", () => {
    const text = sessionReminderCard(cycle, session()).content as string;
    expect(text).toContain("no room booked yet");
  });

  it("asks for videos the day before, and points at the audition command", () => {
    const text = videoReminderCard(session()).content as string;
    expect(text).toContain("tomorrow");
    expect(text).toContain("/audition submit");
  });
});
