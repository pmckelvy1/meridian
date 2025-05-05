import durableObjectsRouter from './routers/durableObjects.router';
import eventsRouter from './routers/events.router';
import openGraph from './routers/openGraph.router';
import reportsRouter from './routers/reports.router';
import sourcesRouter from './routers/sources.router';
import { Env } from './index';
import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';

export type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>()
  .use(trimTrailingSlash())
  .get('/favicon.ico', async c => c.notFound()) // disable favicon
  .route('/reports', reportsRouter)
  .route('/sources', sourcesRouter)
  .route('/openGraph', openGraph)
  .route('/events', eventsRouter)
  .route('/do', durableObjectsRouter)
  .get('/ping', async c => c.json({ pong: true }));

export default app;
