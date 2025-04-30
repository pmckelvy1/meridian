import { Hono } from 'hono';
import { HonoEnv } from '../app';
import { $articles, $sources, getDb, eq, isNull } from '@meridian/database';
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
  .post(
    '/admin/source/:sourceId/init',
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

      const initLogger = logger.child({ operation: 'init-source' });
      const { sourceId } = c.req.valid('param');

      const db = getDb(c.env.DATABASE_URL);

      // Get the source first
      const sourceResult = await tryCatchAsync(
        db.query.$sources.findFirst({
          where: eq($sources.id, Number(sourceId)),
        })
      );

      if (sourceResult.isErr()) {
        const error = sourceResult.error instanceof Error ? sourceResult.error : new Error(String(sourceResult.error));
        initLogger.error('Failed to fetch source', { sourceId }, error);
        return c.json({ error: 'Failed to fetch source' }, 500);
      }

      const source = sourceResult.value;
      if (!source) {
        return c.json({ error: 'Source not found' }, 404);
      }

      // Initialize the DO
      const doId = c.env.SOURCE_SCRAPER.idFromName(source.url);
      const stub = c.env.SOURCE_SCRAPER.get(doId);

      const initResult = await tryCatchAsync(
        // stub.initialize({
        //   id: source.id,
        //   url: source.url,
        //   scrape_frequency: source.scrape_frequency,
        // })
        stub.sayHello()
      );
      if (initResult.isErr()) {
        const error = initResult.error instanceof Error ? initResult.error : new Error(String(initResult.error));
        initLogger.error('Failed to initialize source DO', { sourceId, url: source.url }, error);
        return c.json({ error: 'Failed to initialize source DO' }, 500);
      }

      initLogger.info('Successfully initialized source DO', { sourceId, url: source.url });
      return c.json({ success: true });
    }
  )
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
  );

export default route;
