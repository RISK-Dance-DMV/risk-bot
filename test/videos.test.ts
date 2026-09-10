import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectVideoGroups,
  countLinks,
  driveFileId,
  extractVideoLinks,
} from "../src/applications/videos";

describe("extractVideoLinks", () => {
  it("returns nothing for an empty cell", () => {
    expect(extractVideoLinks("")).toEqual([]);
    expect(extractVideoLinks("   ")).toEqual([]);
  });

  it("keeps the annotation as a label", () => {
    expect(extractVideoLinks("heels solo - https://youtu.be/abc123")).toEqual([
      { url: "https://youtu.be/abc123", label: "heels solo" },
    ]);
  });

  it("splits several URLs on one line and keeps each annotation", () => {
    const links = extractVideoLinks(
      "heels https://youtu.be/aaa , kpop cover https://youtu.be/bbb",
    );
    expect(links).toEqual([
      { url: "https://youtu.be/aaa", label: "heels" },
      { url: "https://youtu.be/bbb", label: "kpop cover" },
    ]);
  });

  it("handles newline-separated cells", () => {
    const links = extractVideoLinks(
      "https://drive.google.com/file/d/1AbC/view\nfreestyle: https://youtu.be/xyz",
    );
    expect(links.map((l) => l.label)).toEqual(["", "freestyle"]);
  });

  it("strips trailing punctuation and de-duplicates", () => {
    const links = extractVideoLinks("https://youtu.be/aaa.\nagain https://youtu.be/aaa");
    expect(links).toEqual([{ url: "https://youtu.be/aaa", label: "" }]);
  });
});

describe("driveFileId", () => {
  it("reads the common Drive URL shapes", () => {
    expect(driveFileId("https://drive.google.com/file/d/1AbCdEfGhIj/view?usp=sharing")).toBe(
      "1AbCdEfGhIj",
    );
    expect(driveFileId("https://docs.google.com/document/d/1AbCdEfGhIj/edit")).toBe(
      "1AbCdEfGhIj",
    );
    expect(driveFileId("https://drive.google.com/open?id=1AbCdEfGhIj")).toBe("1AbCdEfGhIj");
  });

  it("returns null for non-Drive URLs", () => {
    expect(driveFileId("https://youtu.be/abc")).toBeNull();
  });
});

describe("extractVideoLinks — trailing annotations", () => {
  it("keeps a bracketed note with the URL it follows", () => {
    const links = extractVideoLinks(
      "https://youtu.be/aaa (heels), https://youtu.be/bbb (kpop cover)",
    );
    expect(links).toEqual([
      { url: "https://youtu.be/aaa", label: "heels" },
      { url: "https://youtu.be/bbb", label: "kpop cover" },
    ]);
  });
});

describe("collectVideoGroups", () => {
  beforeEach(() => {
    // Every configured column is a Google/YouTube host in these fixtures, so stub
    // the network rather than making the access check real.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
  });
  afterEach(() => vi.unstubAllGlobals());

  /** AM=38, AN=39, AO=40, AP=41. */
  const rowWith = (cells: Partial<Record<38 | 39 | 40 | 41, string>>) => {
    const values = new Array(42).fill("");
    for (const [i, text] of Object.entries(cells)) values[Number(i)] = text;
    return values as string[];
  };

  it("labels each group from its column, skipping empty ones", async () => {
    const groups = await collectVideoGroups(
      rowWith({ 38: "https://youtu.be/crew", 41: "solo take: https://youtu.be/solo" }),
    );
    expect(groups.map((g) => g.label)).toEqual(["Boy Group — CREW", "Girl Group — SOLO"]);
    expect(groups[1]?.links[0]).toMatchObject({
      url: "https://youtu.be/solo",
      label: "solo take",
      access: "public",
    });
  });

  it("lists a link pasted into two columns only once", async () => {
    const groups = await collectVideoGroups(
      rowWith({ 38: "https://youtu.be/same", 39: "https://youtu.be/same" }),
    );
    expect(countLinks(groups)).toBe(1);
    expect(groups.map((g) => g.label)).toEqual(["Boy Group — CREW"]);
  });

  it("returns nothing when no video column is filled", async () => {
    expect(await collectVideoGroups(rowWith({}))).toEqual([]);
  });
});
