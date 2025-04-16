import { $articles } from '@meridian/database';
import { Env } from '../index';
import { getDb, safeFetch } from '../lib/utils';
import { parseRSSFeed } from '../lib/parsers';
import { userAgents } from '../lib/utils';
import { err, ok, Result, ResultAsync } from 'neverthrow';
import { DurableObject } from 'cloudflare:workers';

interface SourceState {
  sourceId: number;
  url: string;
  scrapeFrequencyTier: 1 | 2 | 3 | 4;
  lastChecked: number | null; // Store timestamp as number
}

const tierIntervals = {
  1: 60 * 60 * 1000, // Tier 1: Check every hour
  2: 4 * 60 * 60 * 1000, // Tier 2: Check every 4 hours
  3: 6 * 60 * 60 * 1000, // Tier 3: Check every 6 hours
  4: 24 * 60 * 60 * 1000, // Tier 4: Check every 24 hours
};
const DEFAULT_INTERVAL = tierIntervals[2]; // Default to 4 hours if tier is invalid

// --- Retry Configuration ---
const MAX_STEP_RETRIES = 3; // Max retries for *each* step (fetch, parse, insert)
const INITIAL_RETRY_DELAY_MS = 500; // Start delay, doubles each time

// --- Retry Helper Function ---
async function attemptWithRetries<T, E extends Error>(
  operation: () => Promise<Result<T, E>>,
  maxRetries: number,
  initialDelayMs: number,
  logContext: string // e.g., "Fetch", "Parse", "DB Insert" for logging
): Promise<Result<T, E>> {
  let lastError: E | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`${logContext}: Attempt ${attempt}/${maxRetries}...`);
    const result = await operation();

    if (result.isOk()) {
      console.log(`${logContext}: Attempt ${attempt} successful.`);
      return ok(result.value); // Return successful result immediately
    } else {
      lastError = result.error; // Store the error
      console.warn(`${logContext}: Attempt ${attempt} failed: ${lastError.name} - ${lastError.message}`);

      // If not the last attempt, wait before retrying
      if (attempt < maxRetries) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        console.log(`${logContext}: Waiting ${delay}ms before next attempt.`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // If loop finishes, all retries failed
  console.error(`${logContext}: Failed after ${maxRetries} attempts.`);
  // Ensure lastError is defined before returning, although TS might not know
  return err(lastError!);
}

export class SourceScraperDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    console.log(`DO ${this.ctx.id.toString()}: Constructor running. ID: ${this.ctx.id}`);
  }

  async initialize(sourceData: { id: number; url: string; scrape_frequency: number }): Promise<void> {
    console.log(`DO ${this.ctx.id.toString()}: Initializing with data:`, sourceData);

    const sourceExistsResult = await ResultAsync.fromPromise(
      getDb(this.env.DATABASE_URL).query.$sources.findFirst({ where: (s, { eq }) => eq(s.id, sourceData.id) }),
      e => new Error(`Database query failed: ${e}`)
    );
    if (sourceExistsResult.isErr()) {
      console.error(
        `DO ${this.ctx.id.toString()}: Failed to query DB for source ${sourceData.id}.`,
        sourceExistsResult.error
      );
      throw sourceExistsResult.error; // Rethrow DB error
    }
    if (!sourceExistsResult.value) {
      console.log(`DO ${this.ctx.id.toString()}: Source ${sourceData.id} doesn't exist in DB. Refusing to initialize.`);
      throw new Error(`Source ${sourceData.id} not found in database`);
    }

    let tier = sourceData.scrape_frequency;
    if (![1, 2, 3, 4].includes(tier)) {
      console.warn(
        `DO ${this.ctx.id.toString()} (${sourceData.id}): Invalid scrape_frequency ${tier}. Defaulting to 2.`
      );
      tier = 2; // Default tier
    }

    await this.ctx.storage.put('state', {
      sourceId: sourceData.id,
      url: sourceData.url,
      scrapeFrequencyTier: tier as SourceState['scrapeFrequencyTier'],
      lastChecked: null,
    });
    console.log(`DO ${this.ctx.id.toString()} (${sourceData.id}): Initialized state. Setting initial alarm.`);
    // Set initial alarm immediately, but add a small buffer to avoid potential races if deployed right now
    await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  async alarm(): Promise<void> {
    const doIdStr = this.ctx.id.toString();
    console.log(`DO ${doIdStr}: Alarm triggered.`);

    const state = await this.ctx.storage.get<SourceState>('state');
    if (!state) {
      console.error(`DO ${this.ctx.id.toString()}: State not found in alarm. Cannot proceed.`);
      // Maybe schedule alarm far in the future or log an error to an external system
      // We cannot proceed without state.
      return;
    }

    const { sourceId, url, scrapeFrequencyTier } = state;
    const logPrefix = `DO ${doIdStr} (Src ${sourceId})`;
    const interval = tierIntervals[scrapeFrequencyTier] || DEFAULT_INTERVAL;

    // --- Schedule the *next* regular alarm run immediately ---
    // This ensures that even if this current run fails completely after all retries,
    // the process will attempt again later according to its schedule.
    const nextScheduledAlarmTime = Date.now() + interval;
    await this.ctx.storage.setAlarm(nextScheduledAlarmTime);
    console.log(`${logPrefix}: Next regular alarm scheduled for ${new Date(nextScheduledAlarmTime).toISOString()}.`);

    // --- Workflow Step 1: Fetch Feed with Retries ---
    const fetchLogCtx = `${logPrefix} [Fetch]`;
    const fetchResult = await attemptWithRetries(
      async () => {
        // Wrap safeFetch in a function returning Result
        const respResult = await safeFetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
            // 'Referer': 'https://www.google.com/', // Optional
          },
        });
        if (respResult.isErr()) return err(respResult.error);
        // Ensure response is OK before trying to read body
        if (!respResult.value.ok) {
          return err(new Error(`Fetch failed with status: ${respResult.value.status} ${respResult.value.statusText}`));
        }
        // Read body - this can also fail
        try {
          const text = await respResult.value.text();
          return ok(text);
        } catch (bodyError) {
          return err(bodyError instanceof Error ? bodyError : new Error(`Failed to read response body: ${bodyError}`));
        }
      },
      MAX_STEP_RETRIES,
      INITIAL_RETRY_DELAY_MS,
      fetchLogCtx
    );
    if (fetchResult.isErr()) {
      console.error(`${fetchLogCtx}: Fetch step failed permanently for ${url}. Alarm run terminating.`);
      // No further processing. Next alarm is already scheduled.
      return;
    }
    const feedText = fetchResult.value;

    // --- Workflow Step 2: Parse Feed with Retries ---
    const parseLogCtx = `${logPrefix} [Parse]`;
    const parseResult = await attemptWithRetries(
      async () => parseRSSFeed(feedText),
      MAX_STEP_RETRIES,
      INITIAL_RETRY_DELAY_MS,
      parseLogCtx
    );
    if (parseResult.isErr()) {
      console.error(`${parseLogCtx}: Parse step failed permanently for ${url}. Alarm run terminating.`);
      // No further processing. Next alarm is already scheduled.
      return;
    }
    const articles = parseResult.value; // Type: ParsedArticle[]

    // --- Filter Articles ---
    const now = Date.now();
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const newArticles = articles
      .filter(({ pubDate }) => pubDate === null || pubDate > oneWeekAgo)
      .map(article => ({
        sourceId: sourceId,
        url: article.link, // Make sure link is not null/undefined
        title: article.title, // Make sure title is not null/undefined
        publishDate: article.pubDate, // Use the Date object or format as needed for DB
      }));
    if (newArticles.length === 0) {
      console.log(`${logPrefix}: No new articles found worth inserting.`);
      // Successfully processed, update lastChecked
      state.lastChecked = now;
      await this.ctx.storage.put('state', state);
      console.log(`${logPrefix}: Updated lastChecked to ${new Date(now).toISOString()} as no new articles found.`);
      console.log(`${logPrefix}: Alarm run finished successfully.`);
      return;
    }

    console.log(`${logPrefix}: Found ${newArticles.length} new articles to insert.`);

    // --- Workflow Step 3: Insert Articles with Retries ---
    const dbLogCtx = `${logPrefix} [DB Insert]`;
    const insertResult = await attemptWithRetries(
      async () =>
        ResultAsync.fromPromise(
          getDb(this.env.DATABASE_URL)
            .insert($articles)
            .values(newArticles)
            .onConflictDoNothing({ target: $articles.url }) // Make sure 'url' is unique constraint name or column
            .returning({ insertedId: $articles.id }),
          e => (e instanceof Error ? e : new Error(`DB Insert failed: ${String(e)}`)) // Error mapper
        ),
      MAX_STEP_RETRIES,
      INITIAL_RETRY_DELAY_MS,
      dbLogCtx
    );
    if (insertResult.isErr()) {
      console.error(
        `${dbLogCtx}: DB Insert step failed permanently for ${url}. Error: ${insertResult.error.message}. Alarm run terminating.`
      );
      // No further processing. Next alarm is already scheduled.
      return;
    }

    const insertedRows = insertResult.value; // Type: { insertedId: number }[]
    console.log(`${dbLogCtx}: DB Insert completed. ${insertedRows.length} rows affected by insert/conflict.`);

    // --- Send to Queue (No Retry here, relies on Queue's built-in retries/DLQ) ---
    if (insertedRows.length > 0 && this.env.ARTICLE_PROCESSING_QUEUE) {
      const insertedIds = insertedRows.map(r => r.insertedId);
      const BATCH_SIZE_LIMIT = 100; // Adjust as needed

      console.log(`${logPrefix}: Sending ${insertedIds.length} IDs to queue...`);
      for (let i = 0; i < insertedIds.length; i += BATCH_SIZE_LIMIT) {
        const batch = insertedIds.slice(i, i + BATCH_SIZE_LIMIT);
        console.log(`${logPrefix}: Sending batch of ${batch.length} IDs to queue.`);
        this.ctx.waitUntil(
          this.env.ARTICLE_PROCESSING_QUEUE.send({ articles_id: batch }).catch(queueError => {
            console.error(`${logPrefix}: Failed to send batch to queue: ${queueError}`);
            // Log or handle queue errors if critical - DLQ should catch persistent ones
          })
        );
      }
    }

    // --- Final Step: Update lastChecked only on full success ---
    console.log(`${logPrefix}: All steps successful. Updating lastChecked.`);
    state.lastChecked = now;
    await this.ctx.storage.put('state', state);
    console.log(`${logPrefix}: Updated lastChecked to ${new Date(now).toISOString()}`);

    console.log(`${logPrefix}: Alarm run finished successfully.`);
  }

  // --- fetch and destroy methods (mostly unchanged, added logging context) ---
  async fetch(request: Request): Promise<Response> {
    const doIdStr = this.ctx.id.toString();
    console.log(`DO ${doIdStr}: Received fetch request: ${request.method} ${request.url}`);
    const logPrefix = `DO ${doIdStr} [Fetch API]`;

    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      console.log(`${logPrefix}: Manual trigger received.`);
      await this.ctx.storage.setAlarm(Date.now()); // Trigger alarm soon
      return new Response('Alarm set');
    } else if (url.pathname === '/status') {
      console.log(`${logPrefix}: Status request received.`);
      const state = await this.ctx.storage.get('state');
      const alarm = await this.ctx.storage.getAlarm();
      return Response.json({
        state: state || { error: 'State not initialized' },
        nextAlarmTimestamp: alarm,
      });
    } else if (url.pathname === '/initialize' && request.method === 'POST') {
      console.log(`${logPrefix}: Initialize request received.`);
      try {
        const sourceData = await request.json<{ id: number; url: string; scrape_frequency: number }>();
        if (
          !sourceData ||
          typeof sourceData.id !== 'number' ||
          typeof sourceData.url !== 'string' ||
          typeof sourceData.scrape_frequency !== 'number'
        ) {
          console.warn(`${logPrefix}: Invalid source data format received.`);
          return new Response('Invalid source data format', { status: 400 });
        }
        await this.initialize(sourceData);
        console.log(`${logPrefix}: Initialization successful via API.`);
        return new Response('Initialized');
      } catch (e) {
        console.error(`${logPrefix}: Initialization failed via fetch: ${e}`);
        const error = e instanceof Error ? e : new Error(String(e));
        const status = error.message.includes('not found in database') ? 404 : 500;
        return new Response(`Initialization failed: ${error.message}`, { status: status });
      }
    }
    console.log(`${logPrefix}: Path not found.`);
    return new Response('Not found', { status: 404 });
  }

  async destroy() {
    const doIdStr = this.ctx.id.toString();
    console.log(`DO ${doIdStr}: Destroy called, deleting storage.`);
    await this.ctx.storage.deleteAll();
    console.log(`DO ${doIdStr}: Storage deleted.`);
  }
}
