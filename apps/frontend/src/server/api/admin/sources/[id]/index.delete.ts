import { $sources, eq } from '@meridian/database';
import { getDB } from '~/server/lib/utils';

export default defineEventHandler(async event => {
  await requireUserSession(event); // require auth

  const sourceId = Number(getRouterParam(event, 'id'));
  if (isNaN(sourceId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid source ID' });
  }

  const db = getDB(event);
  const source = await db.query.$sources.findFirst({ where: eq($sources.id, sourceId) });
  if (source === undefined) {
    throw createError({ statusCode: 404, statusMessage: 'Source not found' });
  }

  const config = useRuntimeConfig();

  try {
    const response = await fetch(`${config.public.WORKER_API}/do/admin/source/${sourceId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${config.worker.api_token}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to delete source: ${response.statusText}`);
    }
  } catch (error) {
    console.error('Failed to delete source:', error);
    throw createError({ statusCode: 500, statusMessage: 'Failed to delete source' });
  }

  return { success: true };
});
