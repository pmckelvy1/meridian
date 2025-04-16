import { Env } from '../index';
import { ResultAsync } from 'neverthrow';
import { getDb as getDbFromDatabase } from '@meridian/database';
import { Context } from 'hono';
import { HonoEnv } from '../app';

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

// export const referrers = [];
