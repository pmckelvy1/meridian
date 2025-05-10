import { Hono } from 'hono';
import { HonoEnv } from '../app';
import { $articles, $sources, eq, and, gte, lte, not, isNotNull } from '@meridian/database';
import { hasValidAuthToken, getDb } from '../lib/utils';

const route = new Hono<HonoEnv>().get('/', async c => {
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

  const db = getDb(c.env.HYPERDRIVE);
  const [allSources, events] = await Promise.all([
    db.select({ id: $sources.id, name: $sources.name }).from($sources),
    db
      .select({
        id: $articles.id,
        sourceId: $articles.sourceId,
        url: $articles.url,
        title: $articles.title,
        publishDate: $articles.publishDate,
        contentFileKey: $articles.contentFileKey,
        primary_location: $articles.primary_location,
        completeness: $articles.completeness,
        content_quality: $articles.content_quality,
        event_summary_points: $articles.event_summary_points,
        thematic_keywords: $articles.thematic_keywords,
        topic_tags: $articles.topic_tags,
        key_entities: $articles.key_entities,
        content_focus: $articles.content_focus,
        embedding: $articles.embedding,
        createdAt: $articles.createdAt,
      })
      .from($articles)
      .where(
        and(
          isNotNull($articles.primary_location),
          gte($articles.publishDate, startDate),
          lte($articles.publishDate, endDate),
          not(eq($articles.content_quality, 'JUNK')),
          not(eq($articles.completeness, 'PARTIAL_USELESS')),
          isNotNull($articles.processedAt)
        )
      ),
  ]);

  return c.json({
    sources: allSources,
    events,
    dateRange: {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    },
  });
});

export default route;
