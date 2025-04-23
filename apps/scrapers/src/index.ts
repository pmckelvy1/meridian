import { getDb } from './lib/utils';
import app from './app';
import { SourceScraperDO } from './durable_objects/sourceScraperDO';
import { $sources } from '@meridian/database';
import { startProcessArticleWorkflow } from './workflows/processArticles.workflow';

type ArticleQueueMessage = { articles_id: number[] };

export type Env = {
  // Bindings
  SOURCE_SCRAPER: DurableObjectNamespace<SourceScraperDO>; // *** Add DO Binding ***
  ARTICLE_PROCESSING_QUEUE: Queue<ArticleQueueMessage>; // *** Add Queue Binding ***
  SCRAPE_RSS_FEED: Workflow;
  PROCESS_ARTICLES: Workflow;
  ARTICLES_BUCKET: R2Bucket;
  AI: Ai;

  // Secrets
  CLOUDFLARE_BROWSER_RENDERING_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;

  DATABASE_URL: string;

  GOOGLE_API_KEY: string;
  GOOGLE_BASE_URL: string;

  MERIDIAN_SECRET_KEY: string;
};

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);

    // Route requests intended for specific DOs
    // Example: /do/source/{source_id_or_url_encoded}/*
    if (url.pathname.startsWith('/do/source/')) {
      const pathParts = url.pathname.split('/');
      if (pathParts.length >= 4) {
        const sourceIdentifier = decodeURIComponent(pathParts[3]);
        // Use idFromName to get a consistent DO ID
        // Using URL is generally good practice for external identifiers
        const doId = env.SOURCE_SCRAPER.idFromName(sourceIdentifier);
        const stub = env.SOURCE_SCRAPER.get(doId);

        // Reconstruct the request URL for the DO
        const doPath = '/' + pathParts.slice(4).join('/');
        const doUrl = new URL(doPath + url.search, 'http://do'); // Base doesn't matter much here

        const doRequest = new Request(doUrl.toString(), request);
        return stub.fetch(doRequest);
      }
    }

    // Example endpoint to initialize all DOs from DB (Run once or periodically)
    if (url.pathname === '/admin/initialize-dos') {
      // // Add auth check!
      // if (request.headers.get('Authorization') !== `Bearer ${env.MERIDIAN_SECRET_KEY}`) {
      //   return new Response('Unauthorized', { status: 401 });
      // }

      console.log('Initializing SourceScraperDOs from database...');
      const db = getDb(env.DATABASE_URL); // Use Hyperdrive here too
      const allSources = await db
        .select({ id: $sources.id, url: $sources.url, scrape_frequency: $sources.scrape_frequency })
        .from($sources);

      let count = 0;
      const promises = allSources.map(async source => {
        try {
          const doId = env.SOURCE_SCRAPER.idFromName(source.url); // Use URL for ID stability
          const stub = env.SOURCE_SCRAPER.get(doId);
          // Call the initialize method on the DO
          await stub.fetch('http://do/initialize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(source),
          });
          count++;
        } catch (e) {
          console.error(`Failed to initialize DO for source ${source.id} (${source.url}):`, e);
        }
      });

      await Promise.allSettled(promises);
      console.log(`Initialization process complete. Attempted: ${allSources.length}, Successful: ${count}`);
      return new Response(`Initialized ${count} DOs.`);
    }

    // Fallback to your Hono app for other routes
    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Received batch of ${batch.messages.length} articles to process.`);

    const articlesToProcess: number[] = [];
    for (const message of batch.messages) {
      console.log(message);
      const { articles_id } = message.body as ArticleQueueMessage;
      for (const id of articles_id) {
        articlesToProcess.push(id);
      }
    }

    console.log('articlesToProcess', articlesToProcess);

    if (articlesToProcess.length === 0) {
      console.log('Queue batch was empty, nothing to process.');
      batch.ackAll(); // Acknowledge the empty batch
      return;
    }

    const workflowResult = await startProcessArticleWorkflow(env, { articles_id: articlesToProcess });
    if (workflowResult.isErr()) {
      console.error(`Failed to trigger ProcessArticles Workflow for batch:`, workflowResult.error.message);
      // Retry the entire batch if Workflow creation failed (cautious with retries if the failure is persistent)
      batch.retryAll({ delaySeconds: 30 }); // Retry after 30 seconds
      return;
    }

    console.log(`Successfully triggered ProcessArticles Workflow ${workflowResult.value.id} for batch`);
    batch.ackAll(); // Acknowledge the entire batch now that the Workflow has taken over
  },
} satisfies ExportedHandler<Env>;

export { SourceScraperDO };
export { ProcessArticles } from './workflows/processArticles.workflow';
