import { Env } from '../index';
import { ResultAsync } from 'neverthrow';
import { getDb as getDbFromDatabase } from '@meridian/database';
import { Context } from 'hono';
import { HonoEnv } from '../app';
import { articleAnalysisSchema } from '../prompts/articleAnalysis.prompt';
import { z } from 'zod';

export function getDb(databaseUrl: string) {
  return getDbFromDatabase(databaseUrl, { prepare: false });
}

export const safeFetch = ResultAsync.fromThrowable(
  (url: string, options: RequestInit = {}) =>
    fetch(url, options).then(res => {
      if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
      return res;
    }),
  e => (e instanceof Error ? e : new Error(String(e)))
);

export const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Escape special characters for XML
 */
export function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function cleanString(text: string) {
  return text
    .replace(/[ \t]+/g, ' ') // collapse spaces/tabs
    .replace(/\n\s+/g, '\n') // clean spaces after newlines
    .replace(/\s+\n/g, '\n') // clean spaces before newlines
    .replace(/\n{3,}/g, '\n\n') // keep max 2 consecutive newlines
    .trim(); // clean edges
}

export function cleanUrl(url: string) {
  const u = new URL(url);

  const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
  paramsToRemove.forEach(param => u.searchParams.delete(param));

  return u.toString();
}

export function hasValidAuthToken(c: Context<HonoEnv>) {
  const auth = c.req.header('Authorization');
  if (auth === undefined || auth !== `Bearer ${c.env.MERIDIAN_SECRET_KEY}`) {
    return false;
  }
  return true;
}

export const userAgents = [
  // ios (golden standard for publishers)
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', // iphone safari (best overall)
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.87 Mobile/15E148 Safari/604.1', // iphone chrome

  // android (good alternatives)
  'Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36', // samsung flagship
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36', // pixel
];

export function generateSearchText(data: z.infer<typeof articleAnalysisSchema> & { title: string }): string {
  // helper to safely join string arrays, filtering out empty/nullish items
  const joinSafely = (arr: string[] | null | undefined): string =>
    (arr ?? [])
      .map(s => s?.trim())
      .filter(Boolean)
      .join(' ');

  // process summary points: trim, filter empty, ensure period, join
  const summary = (data.event_summary_points ?? [])
    .map(p => p?.trim() ?? '') // trim first
    .filter(p => p !== '') // remove empties *after* trimming
    .map(p => (p.endsWith('.') ? p : `${p}.`)) // add period if needed
    .join(' '); // join with space

  // process other text arrays simply
  const keywords = joinSafely(data.thematic_keywords);
  const tags = joinSafely(data.topic_tags);
  const entities = joinSafely(data.key_entities);
  const focus = joinSafely(data.content_focus);

  // process location: clean up, remove generic placeholders
  let location = data.primary_location?.trim() ?? '';
  const nonSpecificLocations = ['GLOBAL', 'WORLD', '', 'NONE', 'N/A'];
  if (nonSpecificLocations.includes(location.toUpperCase())) {
    location = ''; // discard if generic
  }

  // get the title safely
  const title = data.title?.trim() ?? '';

  // --- build the final string ---

  const parts = [
    title,
    location, // only included if specific and non-empty
    summary,
    entities,
    keywords,
    tags,
    focus,
  ];

  // join non-empty parts with ". " separator
  let combined = parts.filter(Boolean).join('. '); // filter(Boolean) removes empty strings, null, undefined

  // ensure the final string ends with a period if it contains text
  if (combined && !combined.endsWith('.')) {
    combined += '.';
  }

  // add the required prefix
  return combined;
}
