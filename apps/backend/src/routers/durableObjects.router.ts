import { Hono } from 'hono';
import { HonoEnv } from '../app';
import { $articles, $sources, getDb, eq, isNotNull } from '@meridian/database';
import { hasValidAuthToken } from '../lib/utils';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { tryCatchAsync } from '../lib/tryCatchAsync';
import { Logger } from '../lib/logger';

const logger = new Logger({ router: 'durable-objects' });

const route = new Hono<HonoEnv>()
  // handle DO-specific routes
  .get(
    '/source/:sourceId/*',
    zValidator(
      'param',
      z.object({
        sourceId: z.string().min(1, 'Source ID is required'),
      })
    ),
    async c => {
      const { sourceId } = c.req.valid('param');
      const doId = c.env.SOURCE_SCRAPER.idFromName(decodeURIComponent(sourceId));
      const stub = c.env.SOURCE_SCRAPER.get(doId);

      // reconstruct path for the DO
      const url = new URL(c.req.url);
      const pathParts = url.pathname.split('/');
      const doPath = '/' + pathParts.slice(4).join('/');
      const doUrl = new URL(doPath + url.search, 'http://do');

      const doRequest = new Request(doUrl.toString(), c.req.raw);
      return stub.fetch(doRequest);
    }
  )
  // admin endpoints
  .delete(
    '/admin/source/:sourceId',
    zValidator(
      'param',
      z.object({
        sourceId: z.string().min(1, 'Source ID is required'),
      })
    ),
    async c => {
      // auth check
      if (!hasValidAuthToken(c)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const deleteLogger = logger.child({ operation: 'delete-source' });
      const { sourceId } = c.req.valid('param');

      const db = getDb(c.env.DATABASE_URL);

      // Get the source first to get its URL
      const sourceResult = await tryCatchAsync(
        db.query.$sources.findFirst({
          where: eq($sources.id, Number(sourceId)),
        })
      );

      if (sourceResult.isErr()) {
        const error = sourceResult.error instanceof Error ? sourceResult.error : new Error(String(sourceResult.error));
        deleteLogger.error('Failed to fetch source', { sourceId }, error);
        return c.json({ error: 'Failed to fetch source' }, 500);
      }

      const source = sourceResult.value;
      if (!source) {
        return c.json({ error: 'Source not found' }, 404);
      }

      // Delete the durable object first
      const doId = c.env.SOURCE_SCRAPER.idFromName(source.url);
      const stub = c.env.SOURCE_SCRAPER.get(doId);

      const deleteResult = await tryCatchAsync(
        stub.fetch('http://do/delete', {
          method: 'DELETE',
        })
      );
      if (deleteResult.isErr()) {
        const error = deleteResult.error instanceof Error ? deleteResult.error : new Error(String(deleteResult.error));
        deleteLogger.error('Failed to delete source DO', { sourceId, url: source.url }, error);
        return c.json({ error: 'Failed to delete source DO' }, 500);
      }

      // Then delete from database
      // delete the articles first
      const articlesResult = await tryCatchAsync(db.delete($articles).where(eq($articles.sourceId, Number(sourceId))));
      if (articlesResult.isErr()) {
        const error =
          articlesResult.error instanceof Error ? articlesResult.error : new Error(String(articlesResult.error));
        deleteLogger.error('Failed to delete articles', { sourceId }, error);
        return c.json({ error: 'Failed to delete articles' }, 500);
      }

      const dbDeleteResult = await tryCatchAsync(db.delete($sources).where(eq($sources.id, Number(sourceId))));
      if (dbDeleteResult.isErr()) {
        const error =
          dbDeleteResult.error instanceof Error ? dbDeleteResult.error : new Error(String(dbDeleteResult.error));
        deleteLogger.error('Failed to delete source from database', { sourceId }, error);
        return c.json({ error: 'Failed to delete source from database' }, 500);
      }

      deleteLogger.info('Successfully deleted source', { sourceId, url: source.url });
      return c.json({ success: true });
    }
  )
  .post('/admin/initialize-dos', async c => {
    // auth check
    if (!hasValidAuthToken(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const initLogger = logger.child({ operation: 'initialize-dos' });
    initLogger.info('Initializing SourceScraperDOs from database');

    const db = getDb(c.env.DATABASE_URL);

    // Get batch size from query params, default to 100
    const batchSize = Number(c.req.query('batchSize')) || 100;
    initLogger.info('Using batch size', { batchSize });

    const allSourcesResult = await tryCatchAsync(
      db
        .select({
          id: $sources.id,
          url: $sources.url,
          scrape_frequency: $sources.scrape_frequency,
        })
        .from($sources)
        .where(isNotNull($sources.do_initialized_at))
    );
    if (allSourcesResult.isErr()) {
      const error =
        allSourcesResult.error instanceof Error ? allSourcesResult.error : new Error(String(allSourcesResult.error));
      initLogger.error('Failed to fetch sources from database', undefined, error);
      return c.json({ error: 'Failed to fetch sources from database' }, 500);
    }

    const allSources = allSourcesResult.value;
    initLogger.info('Sources fetched from database', { source_count: allSources.length });

    // Process sources in batches
    let processedCount = 0;
    let successCount = 0;

    // Create batches of sources
    const batches = [];
    for (let i = 0; i < allSources.length; i += batchSize) {
      batches.push(allSources.slice(i, i + batchSize));
    }

    // Process each batch sequentially
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      initLogger.info('Processing batch', { batchIndex: batchIndex + 1, batchSize: batch.length });

      const batchResults = await Promise.all(
        batch.map(async source => {
          const sourceLogger = initLogger.child({ source_id: source.id, url: source.url });
          const doId = c.env.SOURCE_SCRAPER.idFromName(source.url);
          const stub = c.env.SOURCE_SCRAPER.get(doId);

          sourceLogger.debug('Initializing DO');
          const result = await tryCatchAsync(
            stub.fetch('http://do/initialize', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(source),
            })
          );

          if (result.isErr()) {
            const error = result.error instanceof Error ? result.error : new Error(String(result.error));
            sourceLogger.error('Failed to initialize DO', undefined, error);
            return false;
          } else {
            sourceLogger.debug('Successfully initialized DO');
            return true;
          }
        })
      );

      processedCount += batch.length;
      successCount += batchResults.filter(success => success).length;

      initLogger.info('Batch completed', {
        batchIndex: batchIndex + 1,
        batchSuccessful: batchResults.filter(success => success).length,
        totalProcessed: processedCount,
        totalSuccessful: successCount,
      });
    }

    initLogger.info('Initialization process complete', { total: allSources.length, successful: successCount });
    return c.json({ initialized: successCount, total: allSources.length });
  });

export default route;
