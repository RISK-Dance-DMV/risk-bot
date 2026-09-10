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

import { VIDEO_COLUMNS } from "../config/columns";
import { cell } from "./fields";

export interface VideoGroup {
  label: string;
  links: CheckedVideoLink[];
}

/**
 * Reads every configured video column, keeping each column's category as the
 * group label. De-duplicates across columns: the same link pasted into both
 * CREW and SOLO is one link, listed under the first column it appeared in.
 */
export async function collectVideoGroups(
  values: readonly string[],
): Promise<VideoGroup[]> {
  const seen = new Set<string>();
  const groups: VideoGroup[] = [];

  for (const col of VIDEO_COLUMNS) {
    const fresh = extractVideoLinks(cell(values, col.column)).filter((link) => {
      if (seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
    if (fresh.length === 0) continue;
    groups.push({ label: col.label, links: await checkAll(fresh) });
  }
  return groups;
}

export function countLinks(groups: VideoGroup[]): number {
  return groups.reduce((n, g) => n + g.links.length, 0);
}
