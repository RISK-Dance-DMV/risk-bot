/**
 * Video link extraction and share-access checking (design doc s22: "Video cells
 * hold multiple URLs - extract all, keep annotations as labels, check Drive
 * sharing and flag restricted links").
 *
 * Parsing here is pure; the network check is a separate function so it can be
 * stubbed or swapped.
 */

export interface VideoLink {
  url: string;
  /** Annotation text that appeared alongside the URL, if any. */
  label: string;
}

export type LinkAccess = "public" | "restricted" | "unknown";

export interface CheckedVideoLink extends VideoLink {
  access: LinkAccess;
}

const URL_RE = /https?:\/\/[^\s<>()\[\],;"']+/gi;

/** Trailing punctuation people leave when pasting into a form field. */
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?)\]}>'"]+$/, "");
}

function cleanLabel(text: string): string {
  return text
    .replace(/^[\s\-–—:|>*.,()\[\]]+/, "")
    .replace(/[\s\-–—:|,()\[\]]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits a cell into segments that each carry at most one URL, so an annotation
 * stays attached to the link it describes.
 *
 * The split lands *after* each URL rather than before, because form answers put
 * the annotation in front ("heels solo: <link>"). A bracketed note that trails a
 * URL is pulled back to that URL, which covers "<link> (heels), <link> (kpop)".
 */
function segments(text: string): string[] {
  const coarse = text.split(/[\n\r;]+/);
  const out: string[] = [];

  for (const part of coarse) {
    const matches = [...part.matchAll(URL_RE)];
    if (matches.length <= 1) {
      out.push(part);
      continue;
    }

    let cursor = 0;
    for (const m of matches) {
      let end = (m.index ?? 0) + m[0].length;
      const trailing = part.slice(end).match(/^\s*\([^)]*\)|^\s*\[[^\]]*\]/);
      if (trailing) end += trailing[0].length;
      out.push(part.slice(cursor, end));
      cursor = end;
    }
    if (cursor < part.length) out.push(part.slice(cursor));
  }
  return out;
}

export function extractVideoLinks(cellText: string): VideoLink[] {
  if (!cellText?.trim()) return [];
  const links: VideoLink[] = [];
  const seen = new Set<string>();

  for (const segment of segments(cellText)) {
    const match = segment.match(URL_RE);
    if (!match?.[0]) continue;
    const url = trimUrl(match[0]);
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ url, label: cleanLabel(segment.replace(match[0], " ")) });
  }
  return links;
}

const DRIVE_ID_PATTERNS = [
  /\/(?:file|document|presentation|spreadsheets)\/d\/([\w-]{10,})/,
  /\/drive\/(?:u\/\d+\/)?folders\/([\w-]{10,})/,
  /[?&]id=([\w-]{10,})/,
];

export function driveFileId(url: string): string | null {
  for (const re of DRIVE_ID_PATTERNS) {
    const m = url.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

function isGoogleHost(url: string): boolean {
  try {
    return /(^|\.)(drive|docs)\.google\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isYouTube(url: string): boolean {
  try {
    return /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Asks the question a reviewer actually cares about: can someone with the link,
 * signed in as nobody, open this? An authenticated check as the RISK account
 * would answer a different question, since reviewers use their own accounts.
 *
 * YouTube goes through oEmbed, which succeeds for unlisted (fine - the link
 * works) and fails for private (not fine).
 */
export async function checkLinkAccess(url: string): Promise<LinkAccess> {
  try {
    if (isYouTube(url)) {
      const res = await fetch(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
        { redirect: "follow" },
      );
      return res.ok ? "public" : "restricted";
    }

    if (!isGoogleHost(url)) return "unknown";

    const res = await fetch(url, { redirect: "manual" });
    if (res.status === 200) return "public";
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return "restricted";
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location") ?? "";
      return location.includes("accounts.google.com") ? "restricted" : "unknown";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function checkAll(links: VideoLink[]): Promise<CheckedVideoLink[]> {
  return Promise.all(
    links.map(async (link) => ({ ...link, access: await checkLinkAccess(link.url) })),
  );
}

// ------------------------------------------------------- per-column grouping

import {
  AUDITION_VIDEO_COLUMN,
  AUDITION_VIDEO_LABEL,
  VIDEO_COLUMNS,
} from "../config/columns";
import { cell } from "./fields";

export interface VideoGroup {
  label: string;
  links: CheckedVideoLink[];
}

/**
 * Reads every configured video column, keeping each column's category as the
 * group label.
 *
 * A link submitted for two categories appears under both. The columns *are* the
 * categories, so collapsing a repeat would hide that the applicant offered the
 * same piece for CREW and SOLO - which is something a reviewer wants to see.
 *
 * The sharing check is still done once per unique URL, because that costs a
 * network request and a Worker has a fixed budget of them.
 */
export async function collectVideoGroups(
  values: readonly string[],
): Promise<VideoGroup[]> {
  const checked = new Map<string, LinkAccess>();
  const groups: VideoGroup[] = [];

  for (const col of VIDEO_COLUMNS) {
    const links = extractVideoLinks(cell(values, col.column));
    if (links.length === 0) continue;

    const withAccess: CheckedVideoLink[] = [];
    for (const link of links) {
      let access = checked.get(link.url);
      if (access === undefined) {
        access = await checkLinkAccess(link.url);
        checked.set(link.url, access);
      }
      withAccess.push({ ...link, access });
    }
    groups.push({ label: col.label, links: withAccess });
  }
  return groups;
}

export function countLinks(groups: VideoGroup[]): number {
  return groups.reduce((n, g) => n + g.links.length, 0);
}

/**
 * The audition form's own video, read from a row of the *audition* sheet.
 *
 * One group rather than merged into the application's, because where a video
 * came from is the thing a reviewer is judging: an audition done through the
 * RISK process is not the same evidence as links pasted into an application.
 */
export async function collectAuditionVideos(
  values: readonly string[],
): Promise<VideoGroup[]> {
  const links = extractVideoLinks(cell(values, AUDITION_VIDEO_COLUMN));
  if (links.length === 0) return [];
  return [{ label: AUDITION_VIDEO_LABEL, links: await checkAll(links) }];
}
