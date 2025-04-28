import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoEnv } from '../app';
import { $reports, desc, eq, and } from '@meridian/database';
import { hasValidAuthToken, getDb } from '../lib/utils';
import { zValidator } from '@hono/zod-validator';
import { tryCatchAsync } from '../lib/tryCatchAsync';

// Cycle break times in EST
const CYCLE_BREAKS = [6, 14, 22]; // 6am, 2pm, 10pm EST

function getCycleBoundaries(dt: Date): { cycle_start: Date; cycle_end: Date } {
  // Convert to EST
  const est = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });

  const hour = parseInt(est.format(dt));

  // Find the most recent cycle break
  let cycleEndHour = Math.max(...CYCLE_BREAKS.filter(h => h <= hour));
  if (cycleEndHour > hour) {
    cycleEndHour = CYCLE_BREAKS[CYCLE_BREAKS.length - 1];
    dt = new Date(dt.getTime() - 24 * 60 * 60 * 1000); // Subtract one day
  }

  // Set cycle end time
  const cycleEnd = new Date(dt);
  cycleEnd.setHours(cycleEndHour, 0, 0, 0);

  // Set cycle start time (8 hours before end)
  const cycleStart = new Date(cycleEnd.getTime() - 8 * 60 * 60 * 1000);

  return { cycle_start: cycleStart, cycle_end: cycleEnd };
}

const route = new Hono<HonoEnv>()
  .get('/last-report', async c => {
    // check auth token
    const hasValidToken = hasValidAuthToken(c);
    if (!hasValidToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const reportResult = await tryCatchAsync(
      getDb(c.env.HYPERDRIVE).query.$reports.findFirst({
        orderBy: desc($reports.createdAt),
      })
    );
    if (reportResult.isErr()) {
      return c.json({ error: 'Failed to fetch last report' }, 500);
    }

    const report = reportResult.value;
    if (report === undefined) {
      return c.json({ error: 'No report found' }, 404);
    }

    return c.json(report);
  })
  .get('/report', async c => {
    // check auth token
    const hasValidToken = hasValidAuthToken(c);
    if (!hasValidToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const dateStr = c.req.query('date');
    if (!dateStr) {
      return c.json({ error: 'Date parameter is required' }, 400);
    }

    try {
      const dt = new Date(dateStr);
      if (isNaN(dt.getTime())) {
        return c.json({ error: 'Invalid date format' }, 400);
      }

      const { cycle_start, cycle_end } = getCycleBoundaries(dt);

      const report = await getDb(c.env.DATABASE_URL).query.$reports.findFirst({
        where: and(eq($reports.cycle_start, cycle_start), eq($reports.cycle_end, cycle_end)),
      });

      if (report === undefined) {
        return c.json({ error: 'No report found for this cycle' }, 404);
      }

      return c.json(report);
    } catch (error) {
      console.error('Error fetching report by date', error);
      return c.json({ error: 'Failed to fetch report by date' }, 500);
    }
  })
  .get('/cycle', async c => {
    // check auth token
    const hasValidToken = hasValidAuthToken(c);
    if (!hasValidToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const cycleStart = c.req.query('cycle_start');
    const cycleEnd = c.req.query('cycle_end');

    if (!cycleStart || !cycleEnd) {
      return c.json({ error: 'Both cycle_start and cycle_end parameters are required' }, 400);
    }

    try {
      const startDate = new Date(cycleStart);
      const endDate = new Date(cycleEnd);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return c.json({ error: 'Invalid date format' }, 400);
      }

      const report = await getDb(c.env.DATABASE_URL).query.$reports.findFirst({
        where: and(eq($reports.cycle_start, startDate), eq($reports.cycle_end, endDate)),
      });

      if (report === undefined) {
        return c.json({ error: 'No report found for this cycle' }, 404);
      }

      return c.json(report);
    } catch (error) {
      console.error('Error fetching report by cycle', error);
      return c.json({ error: 'Failed to fetch report by cycle' }, 500);
    }
  })
  .post(
    '/report',
    zValidator(
      'json',
      z.object({
        title: z.string(),
        content: z.string(),
        totalArticles: z.number(),
        totalSources: z.number(),
        usedArticles: z.number(),
        usedSources: z.number(),
        tldr: z.string(),
        createdAt: z.coerce.date(),
        model_author: z.string(),
        cycle_start: z.coerce.date(),
        cycle_end: z.coerce.date(),
        clustering_params: z.object({
          umap: z.object({
            n_neighbors: z.number(),
          }),
          hdbscan: z.object({
            min_cluster_size: z.number(),
            min_samples: z.number(),
            epsilon: z.number(),
          }),
        }),
      })
    ),
    async c => {
      if (!hasValidAuthToken(c)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const db = getDb(c.env.HYPERDRIVE);
      const body = c.req.valid('json');

      const reportResult = await tryCatchAsync(db.insert($reports).values(body));
      if (reportResult.isErr()) {
        return c.json({ error: 'Failed to insert report' }, 500);
      }

      return c.json({ success: true });
    }
  );

export default route;
