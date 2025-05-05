import { $reports, desc, getDb } from '@meridian/database';
import { ensureDate, formatReportDate, generateReportSlug, getDB } from '~/server/lib/utils';

export default defineEventHandler(async event => {
  const reports = await getDB(event).query.$reports.findMany({
    orderBy: desc($reports.createdAt),
    columns: { id: true, createdAt: true, title: true },
  });

  // Process reports to add date and slug
  return reports.map(report => {
    const createdAt = ensureDate(report.createdAt);
    return {
      ...report,
      date: formatReportDate(createdAt),
      slug: report.id.toString(),
    };
  });
});
