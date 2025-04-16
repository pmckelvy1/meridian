import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoEnv } from '../app';
import { $reports, $sources, desc, eq, getDb } from '@meridian/database';
import { hasValidAuthToken } from '../lib/utils';
import { zValidator } from '@hono/zod-validator';

const route = new Hono<HonoEnv>()
  .get('/', async c => {
    // // check auth token
    // const hasValidToken = hasValidAuthToken(c);
    // if (!hasValidToken) {
    //   return c.json({ error: 'Unauthorized' }, 401);
    // }

    try {
      const sources = await getDb(c.env.DATABASE_URL).query.$sources.findMany();
      return c.json(sources);
    } catch (error) {
      console.error('Error fetching sources', error);
      return c.json({ error: 'Failed to fetch sources' }, 500);
    }
  })
  .get(
    '/delete/:id',
    zValidator(
      'param',
      z.object({
        id: z.coerce.number(),
      })
    ),
    async c => {
      const db = getDb(c.env.DATABASE_URL);

      const source = await db.query.$sources.findFirst({
        where: eq($sources.id, c.req.valid('param').id),
      });
      if (source === undefined) {
        return c.json({ error: "Source doesn't exist" }, 404);
      }

      const doId = c.env.SOURCE_SCRAPER.idFromName(source.url); // Use URL for ID stability
      const stub = c.env.SOURCE_SCRAPER.get(doId);

      try {
        // delete
        await Promise.all([db.delete($sources).where(eq($sources.id, c.req.valid('param').id)), stub.destroy()]);

        return c.json({ success: true });
      } catch (error) {
        console.error('Failed to delete source', error);
        return c.json({ error: 'Failed to delete source' }, 500);
      }
    }
  );

export default route;
