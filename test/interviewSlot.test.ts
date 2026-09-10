import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINUTES,
  formatSlot,
  renderInterviewLine,
  validateSlot,
  type InterviewRecord,
} from "../src/applications/interviewSlot";

const record = (over: Partial<InterviewRecord> = {}): InterviewRecord => ({
  state: "drafted",
  date: "2026-09-20",
  time: "14:30",
  durationMinutes: 30,
  draftedBy: "d1",
  draftedAt: "2026-09-10T00:00:00Z",
  ...over,
});

describe("validateSlot", () => {
  it("normalises a good slot", () => {
    expect(validateSlot("2026-09-20", "9:05", "45")).toEqual({
      ok: true,
      date: "2026-09-20",
      time: "09:05",
      durationMinutes: 45,
    });
  });

  it("defaults the duration when left blank", () => {
    const slot = validateSlot("2026-09-20", "14:30", "  ");
    expect(slot).toMatchObject({ ok: true, durationMinutes: DEFAULT_MINUTES });
  });

  it("rejects a date in the wrong shape", () => {
    const slot = validateSlot("20/09/2026", "14:30", "");
    expect(slot.ok).toBe(false);
    if (!slot.ok) expect(slot.reason).toContain("2026-09-20");
  });

  it("rejects a date that doesn't exist", () => {
    const slot = validateSlot("2026-02-30", "14:30", "");
    expect(slot.ok).toBe(false);
    if (!slot.ok) expect(slot.reason).toContain("no such date");
  });

  it("rejects an impossible time", () => {
    expect(validateSlot("2026-09-20", "24:00", "").ok).toBe(false);
    expect(validateSlot("2026-09-20", "14:60", "").ok).toBe(false);
  });

  it("rejects a time in the wrong shape", () => {
    const slot = validateSlot("2026-09-20", "2:30pm", "");
    expect(slot.ok).toBe(false);
    if (!slot.ok) expect(slot.reason).toContain("14:30");
  });

  it("rejects a duration that isn't a sane whole number", () => {
    expect(validateSlot("2026-09-20", "14:30", "0").ok).toBe(false);
    expect(validateSlot("2026-09-20", "14:30", "600").ok).toBe(false);
    expect(validateSlot("2026-09-20", "14:30", "30.5").ok).toBe(false);
    expect(validateSlot("2026-09-20", "14:30", "half an hour").ok).toBe(false);
  });
});

describe("formatSlot", () => {
  it("reads as a person would say it", () => {
    expect(formatSlot("2026-09-20", "14:30")).toBe("Sunday 20 September 2026, 2:30pm");
  });

  it("handles midnight and noon without saying 0:00", () => {
    expect(formatSlot("2026-09-20", "00:00")).toContain("12:00am");
    expect(formatSlot("2026-09-20", "12:00")).toContain("12:00pm");
  });

  it("keeps the leading zero on minutes", () => {
    expect(formatSlot("2026-09-20", "09:05")).toContain("9:05am");
  });
});

describe("renderInterviewLine", () => {
  it("is explicit that a drafted offer has not been sent", () => {
    const line = renderInterviewLine(record());
    expect(line).toContain("drafted");
    expect(line).toContain("not offered yet");
  });

  it("says an offered one is waiting on them", () => {
    expect(renderInterviewLine(record({ state: "offered" }))).toContain("waiting on their reply");
  });

  it("says a scheduled one has an invite out", () => {
    expect(renderInterviewLine(record({ state: "scheduled" }))).toContain("calendar invite sent");
  });

  it("always names the slot", () => {
    for (const state of ["drafted", "offered", "scheduled"] as const) {
      expect(renderInterviewLine(record({ state }))).toContain("Sunday 20 September 2026, 2:30pm");
    }
  });
});
