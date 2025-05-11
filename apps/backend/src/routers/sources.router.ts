import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoEnv } from '../app';
import { $sources, eq } from '@meridian/database';
import { zValidator } from '@hono/zod-validator';
import { tryCatchAsync } from '../lib/tryCatchAsync';
import { hasValidAuthToken, getDb } from '../lib/utils';
import { Logger } from '../lib/logger';

const logger = new Logger({ router: 'sources' });

const route = new Hono<HonoEnv>()
  .post(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string(),
        url: z.string().url(),
        category: z.string(),
        paywall: z.boolean().optional(),
      })
    ),
    async c => {
      if (!hasValidAuthToken(c)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const routeLogger = logger.child({
        operation: 'create-source',
        source_name: c.req.valid('json').name,
      });
      routeLogger.info('Attempting to create source');

      const db = getDb(c.env.HYPERDRIVE);

      const result = await tryCatchAsync(
        db.insert($sources).values({
          name: c.req.valid('json').name,
          url: c.req.valid('json').url,
          category: c.req.valid('json').category,
          scrape_frequency: 2, // Default value
          paywall: c.req.valid('json').paywall ?? false,
        })
      );

      if (result.isErr()) {
        const error = result.error instanceof Error ? result.error : new Error(String(result.error));
        routeLogger.error('Failed to create source', undefined, error);
        return c.json({ error: 'Failed to create source' }, 500);
      }

      routeLogger.info('Source created successfully');
      return c.json({ success: true });
    }
  )
  .delete(
    '/:id',
    zValidator(
      'param',
      z.object({
        id: z.coerce.number(),
      })
    ),
    async c => {
      if (!hasValidAuthToken(c)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const routeLogger = logger.child({
        operation: 'delete-source',
        source_id: c.req.valid('param').id,
      });
      routeLogger.info('Attempting to delete source');

      const db = getDb(c.env.HYPERDRIVE);

      const sourceResult = await tryCatchAsync(
        db.query.$sources.findFirst({
          where: eq($sources.id, c.req.valid('param').id),
        })
      );
      if (sourceResult.isErr()) {
        const error = sourceResult.error instanceof Error ? sourceResult.error : new Error(String(sourceResult.error));
        routeLogger.error('Failed to fetch source', undefined, error);
        return c.json({ error: 'Failed to fetch source' }, 500);
      }

      const source = sourceResult.value;
      if (source === undefined) {
        routeLogger.warn('Source not found');
        return c.json({ error: "Source doesn't exist" }, 404);
      }

      routeLogger.debug('Source found, proceeding with deletion', { source_url: source.url });
      const doId = c.env.SOURCE_SCRAPER.idFromName(source.url); // Use URL for ID stability
      const stub = c.env.SOURCE_SCRAPER.get(doId);

      const deleteResult = await tryCatchAsync(
        Promise.all([db.delete($sources).where(eq($sources.id, c.req.valid('param').id)), stub.destroy()])
      );
      if (deleteResult.isErr()) {
        const error = deleteResult.error instanceof Error ? deleteResult.error : new Error(String(deleteResult.error));
        routeLogger.error('Failed to delete source', undefined, error);
        return c.json({ error: 'Failed to delete source' }, 500);
      }

      routeLogger.info('Source deleted successfully');
      return c.json({ success: true });
    }
  );

export default route;
