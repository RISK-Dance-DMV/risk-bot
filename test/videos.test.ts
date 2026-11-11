import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectAuditionVideos,
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
      rowWith({ 38: "https://youtu.be/boy", 40: "heels: https://youtu.be/girl" }),
    );
    expect(groups.map((g) => g.label)).toEqual(["Boy Group", "Girl Group"]);
    expect(groups[1]?.links[0]).toMatchObject({
      url: "https://youtu.be/girl",
      label: "heels",
      access: "public",
    });
  });

  it("ignores the retired SOLO columns", async () => {
    const groups = await collectVideoGroups(
      rowWith({ 39: "https://youtu.be/old-boy-solo", 41: "https://youtu.be/old-girl-solo" }),
    );
    expect(groups).toEqual([]);
  });

  it("shows a link submitted for two categories under both", async () => {
    const groups = await collectVideoGroups(
      rowWith({ 38: "https://youtu.be/same", 40: "https://youtu.be/same" }),
    );
    expect(countLinks(groups)).toBe(2);
    expect(groups.map((g) => g.label)).toEqual(["Boy Group", "Girl Group"]);
  });

  it("returns nothing when no video column is filled", async () => {
    expect(await collectVideoGroups(rowWith({}))).toEqual([]);
  });
});

describe("checking a repeated link", () => {
  beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
  afterEach(() => vi.unstubAllGlobals());

  it("checks each unique URL once however many columns it appears in", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("{}", { status: 200 });
    });

    const values = new Array(50).fill("");
    values[38] = "https://youtu.be/same";
    values[40] = "https://youtu.be/same\nhttps://youtu.be/other";

    const groups = await collectVideoGroups(values as string[]);
    // Three links shown - the repeat belongs under both categories - but only
    // two distinct URLs, so only two access checks.
    expect(countLinks(groups)).toBe(3);
    expect(calls).toBe(2);
  });
});

describe("collectAuditionVideos", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Column D of the audition sheet — not the application sheet. */
  const auditionRow = (text: string) => {
    const values = new Array(8).fill("");
    values[3] = text;
    return values as string[];
  };

  it("reads the link out of column D", async () => {
    const groups = await collectAuditionVideos(auditionRow("https://youtu.be/aud"));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("RISK Audition");
    expect(groups[0]?.links[0]).toMatchObject({
      url: "https://youtu.be/aud",
      access: "public",
    });
  });

  it("keeps the group separate rather than folding it into the application's", async () => {
    const combined = [
      ...(await collectVideoGroups(new Array(45).fill(""))),
      ...(await collectAuditionVideos(auditionRow("https://youtu.be/aud"))),
    ];
    expect(combined.map((g) => g.label)).toEqual(["RISK Audition"]);
  });

  it("returns nothing when column D is empty", async () => {
    expect(await collectAuditionVideos(auditionRow("  "))).toEqual([]);
  });

  it("takes every link when they pasted more than one", async () => {
    const groups = await collectAuditionVideos(
      auditionRow("https://youtu.be/one\nhttps://youtu.be/two"),
    );
    expect(countLinks(groups)).toBe(2);
  });
});
