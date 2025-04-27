import { $articles, $sources, and, gte, lte, isNotNull, eq, not } from '@meridian/database';
import { Env } from './index';
import { getDb, hasValidAuthToken } from './lib/utils';
import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import openGraph from './routers/openGraph.router';
import reportsRouter from './routers/reports.router';
import { startRssFeedScraperWorkflow } from './workflows/rssFeed.workflow';
import { getRssFeedWithFetch } from './lib/puppeteer';
import { parseRSSFeed } from './lib/parsers';
import { startProcessArticleWorkflow } from './workflows/processArticles.workflow';

export type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>()
  .use(trimTrailingSlash())
  .get('/favicon.ico', async c => c.notFound()) // disable favicon
  .route('/reports', reportsRouter)
  .route('/openGraph', openGraph)
  .get('/ping', async c => c.json({ pong: true }))
  .post('/sources', async c => {
    const db = getDb(c.env.DATABASE_URL);
    const body = await c.req.json();

    // Validate required fields
    if (!body.name || !body.url || !body.category) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    try {
      const result = await db.insert($sources).values({
        name: body.name,
        url: body.url,
        category: body.category,
        scrape_frequency: 2, // Default value
        paywall: body.paywall || false, // Use the value from frontend or default to false
      });

      return c.json({ success: true });
    } catch (error) {
      console.error('Error creating source:', error);
      return c.json({ error: 'Failed to create source' }, 500);
    }
  })
  .get('/events', async c => {
    // require bearer auth token
    const hasValidToken = hasValidAuthToken(c);
    if (!hasValidToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Check if date parameters were provided in ISO datetime format
    const startDateParam = c.req.query('startDate');
    const endDateParam = c.req.query('endDate');
    const dateParam = c.req.query('date'); // Keep for backward compatibility

    let startDate: Date;
    let endDate: Date;

    if (dateParam) {
      // Backward compatibility: Use the old 30-hour window logic
      endDate = new Date(dateParam);
      if (isNaN(endDate.getTime())) {
        return c.json({ error: 'Invalid date format. Please use ISO datetime format (e.g. YYYY-MM-DDTHH:mm:ss)' }, 400);
      }
      // Set to 7am UTC on the specified date
      endDate.setUTCHours(7, 0, 0, 0);
      // Create a 30-hour window
      startDate = new Date(endDate.getTime() - 30 * 60 * 60 * 1000);
    } else {
      // New logic: Use provided start and end dates
      if (!startDateParam || !endDateParam) {
        return c.json(
          { error: 'Both startDate and endDate parameters are required when not using the date parameter' },
          400
        );
      }

      startDate = new Date(startDateParam);
      endDate = new Date(endDateParam);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return c.json({ error: 'Invalid date format. Please use ISO datetime format (e.g. YYYY-MM-DDTHH:mm:ss)' }, 400);
      }

      if (startDate > endDate) {
        return c.json({ error: 'startDate must be before endDate' }, 400);
      }
    }

    console.log('db url', c.env.DATABASE_URL);
    const db = getDb(c.env.DATABASE_URL);

    const allSources = await db.select({ id: $sources.id, name: $sources.name }).from($sources);

    let events = await db
      .select({
        id: $articles.id,
        sourceId: $articles.sourceId,
        url: $articles.url,
        title: $articles.title,
        publishDate: $articles.publishDate,
        content: $articles.content,
        location: $articles.location,
        completeness: $articles.completeness,
        relevance: $articles.relevance,
        summary: $articles.summary,
        createdAt: $articles.createdAt,
      })
      .from($articles)
      .where(
        and(
          isNotNull($articles.location),
          gte($articles.publishDate, startDate),
          lte($articles.publishDate, endDate),
          eq($articles.relevance, 'RELEVANT'),
          not(eq($articles.completeness, 'PARTIAL_USELESS')),
          isNotNull($articles.summary)
        )
      );

    const response = {
      sources: allSources,
      events,
      dateRange: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
    };

    return c.json(response);
  })
  .get('/trigger-rss', async c => {
    const token = c.req.query('token');
    if (token !== c.env.MERIDIAN_SECRET_KEY) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const res = await startRssFeedScraperWorkflow(c.env, { force: true });
    if (res.isErr()) {
      return c.json({ error: res.error }, 500);
    }

    return c.json({ success: true });
  })
  .get('test-process', async c => {
    const res = await startProcessArticleWorkflow(c.env);
    if (res.isErr()) {
      return c.json({ error: res.error }, 500);
    }

    return c.json({ success: true });
  });

export default app;
