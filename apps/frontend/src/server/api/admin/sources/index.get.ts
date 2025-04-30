import { sql } from '@meridian/database';
import { getDB } from '~/server/lib/utils';

export default defineEventHandler(async event => {
  await requireUserSession(event); // require auth

  const db = getDB(event);
  const sources = await db.query.$sources.findMany();
  if (sources.length === 0) {
    return [];
  }

  // get article stats for last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const articleStats = await db.query.$articles.findMany({
    where: sql`created_at >= ${sevenDaysAgo.toISOString()}`,
    columns: {
      sourceId: true,
      status: true,
      content_quality: true,
      createdAt: true,
      processedAt: true,
    },
  });

  const sourceStats = sources.map(source => {
    const sourceArticles = articleStats.filter(a => a.sourceId === source.id);
    const last24hArticles = sourceArticles.filter(
      a => a.createdAt && new Date(a.createdAt) > new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    // calculate health metrics
    const totalArticles = sourceArticles.length;
    const processedArticles = sourceArticles.filter(a => a.status === 'PROCESSED');
    const failedArticles = sourceArticles.filter(a => a.status?.endsWith('_FAILED'));
    const lowQualityArticles = processedArticles.filter(
      a => a.content_quality === 'LOW_QUALITY' || a.content_quality === 'JUNK'
    );

    // calculate processing time for processed articles
    const processingTimes = processedArticles
      .map(a =>
        a.processedAt && a.createdAt ? new Date(a.processedAt).getTime() - new Date(a.createdAt).getTime() : null
      )
      .filter(time => time !== null);

    const avgProcessingTime = processingTimes.length
      ? Math.round(processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length / 1000) // in seconds
      : null;

    return {
      id: source.id,
      name: source.name,
      url: source.url,
      category: source.category,
      paywall: source.paywall,
      frequency:
        source.scrape_frequency === 1
          ? 'Hourly'
          : source.scrape_frequency === 2
            ? '4 Hours'
            : source.scrape_frequency === 3
              ? '6 Hours'
              : 'Daily',
      lastChecked: source.lastChecked?.toISOString(),

      // article counts
      totalArticles: sourceArticles.length,
      avgPerDay: last24hArticles.length / 24,

      // health metrics
      processSuccessRate: totalArticles ? (processedArticles.length / totalArticles) * 100 : null,
      errorRate: totalArticles ? (failedArticles.length / totalArticles) * 100 : null,
      lowQualityRate: processedArticles.length ? (lowQualityArticles.length / processedArticles.length) * 100 : null,
      avgProcessingTime,
    };
  });

  return sourceStats;
});
