import { $reports, eq, and, gte, lte } from '@meridian/database';
import { ensureDate, formatReportDate, getDB } from '~/server/lib/utils';

interface Brief {
  id: number;
  createdAt: Date;
  title: string;
  content: string;
  model_author: string | null;
  totalArticles: number;
  totalSources: number;
  usedSources: number;
  usedArticles: number;
  slug: string;
  date: {
    month: string;
    day: number;
    year: number;
  };
}

export default defineEventHandler(async event => {
  const slug = getRouterParam(event, 'slug');
  if (slug === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Slug is required' });
  }

  // Parse the report ID from the slug
  const reportId = parseInt(slug, 10);
  if (isNaN(reportId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid slug' });
  }

  // get report by ID
  const report = await getDB(event).query.$reports.findFirst({
    where: eq($reports.id, reportId),
    columns: {
      id: true,
      createdAt: true,
      title: true,
      content: true,
      model_author: true,
      totalArticles: true,
      totalSources: true,
      usedSources: true,
      usedArticles: true,
    },
  });
  if (report === undefined) {
    throw createError({ statusCode: 404, statusMessage: 'Report not found' });
  }

  return {
    ...report,
    slug,
    date: formatReportDate(ensureDate(report.createdAt)),
  } satisfies Brief;
});
