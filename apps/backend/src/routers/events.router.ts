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

  // Check if a date query parameter was provided in yyyy-mm-dd format
  const dateParam = c.req.query('date');

  let endDate: Date;
  if (dateParam) {
    // Parse the date parameter explicitly with UTC
    // Append T07:00:00Z to ensure it's 7am UTC
    endDate = new Date(`${dateParam}T07:00:00Z`);
    // Check if date is valid
    if (isNaN(endDate.getTime())) {
      return c.json({ error: 'Invalid date format. Please use yyyy-mm-dd' }, 400);
    }
  } else {
    // Use current date if no date parameter was provided
    endDate = new Date();
    // Set to 7am UTC today
    endDate.setUTCHours(7, 0, 0, 0);
  }

  // Create a 30-hour window ending at 7am UTC on the specified date
  const startDate = new Date(endDate.getTime() - 30 * 60 * 60 * 1000);

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
