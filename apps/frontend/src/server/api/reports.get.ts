import { ensureDate, formatReportDate, generateReportSlug, getDB } from '~/server/lib/utils';

export default defineEventHandler(async event => {
  const reports = await getDB(event).query.$reports.findMany();

  // Process reports to add date and slug
  const processedReports = reports
    .map(report => {
      const createdAt = ensureDate(report.createdAt);
      return {
        ...report,
        date: formatReportDate(createdAt),
        slug: generateReportSlug(createdAt),
      };
    })
    .sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

  return processedReports;
});
