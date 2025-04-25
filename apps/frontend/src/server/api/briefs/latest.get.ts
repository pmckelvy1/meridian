import { $reports, desc } from '@meridian/database';
import { ensureDate, generateReportSlug, getDB } from '~/server/lib/utils';

export default defineEventHandler(async event => {
  const latestReport = await getDB(event).query.$reports.findFirst({
    orderBy: desc($reports.createdAt),
    columns: { id: true, createdAt: true, title: true },
  });
  if (latestReport === undefined) {
    throw createError({ statusCode: 404, statusMessage: 'No reports found' });
  }

  return generateReportSlug(ensureDate(latestReport.createdAt));
});
