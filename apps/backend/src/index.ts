import app from './app';
import { SourceScraperDO } from './durable_objects/sourceScraperDO';
import { startProcessArticleWorkflow } from './workflows/processArticles.workflow';
import { Logger } from './lib/logger';

type ArticleQueueMessage = { articles_id: number[] };

export type Env = {
  // Bindings
  ARTICLES_BUCKET: R2Bucket;
  ARTICLE_PROCESSING_QUEUE: Queue<ArticleQueueMessage>;
  SOURCE_SCRAPER: DurableObjectNamespace<SourceScraperDO>;
  PROCESS_ARTICLES: Workflow;
  HYPERDRIVE: Hyperdrive;

  // Secrets
  API_TOKEN: string;

  AXIOM_DATASET: string | undefined; // optional, use if you want to send logs to axiom
  AXIOM_TOKEN: string | undefined; // optional, use if you want to send logs to axiom

  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;

  DATABASE_URL: string;

  GEMINI_API_KEY: string;
  GEMINI_BASE_URL: string;

  MERIDIAN_ML_SERVICE_URL: string;
  MERIDIAN_ML_SERVICE_API_KEY: string;
};

// Create a base logger for the queue handler
const queueLogger = new Logger({ service: 'article-queue-handler' });

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const batchLogger = queueLogger.child({ batch_size: batch.messages.length });
    batchLogger.info('Received batch of articles to process');

    const articlesToProcess: number[] = [];
    for (const message of batch.messages) {
      const { articles_id } = message.body as ArticleQueueMessage;
      batchLogger.debug('Processing message', { message_id: message.id, article_count: articles_id.length });

      for (const id of articles_id) {
        articlesToProcess.push(id);
      }
    }

    batchLogger.info('Articles extracted from batch', { total_articles: articlesToProcess.length });

    if (articlesToProcess.length === 0) {
      batchLogger.info('Queue batch was empty, nothing to process');
      batch.ackAll(); // Acknowledge the empty batch
      return;
    }

    const workflowResult = await startProcessArticleWorkflow(env, { articles_id: articlesToProcess });
    if (workflowResult.isErr()) {
      batchLogger.error(
        'Failed to trigger ProcessArticles Workflow',
        { error_message: workflowResult.error.message },
        workflowResult.error
      );
      // Retry the entire batch if Workflow creation failed (cautious with retries if the failure is persistent)
      batch.retryAll({ delaySeconds: 30 }); // Retry after 30 seconds
      return;
    }

    batchLogger.info('Successfully triggered ProcessArticles Workflow', {
      workflow_id: workflowResult.value.id,
      article_count: articlesToProcess.length,
    });
    batch.ackAll(); // Acknowledge the entire batch now that the Workflow has taken over
  },
  async tail(events: TraceItem[], env: Env) {
    const axiomToken = env.AXIOM_TOKEN;
    const axiomDataset = env.AXIOM_DATASET;

    // only proceed if axiomToken and axiomDataset are set
    if (!axiomToken || !axiomDataset) {
      return;
    }

    await fetch(`https://api.axiom.co/v1/datasets/${axiomDataset}/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${axiomToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        // flatten all logs from all events and transform to axiom format
        events.flatMap(event => {
          // base context that'll be added to every log
          const context = {
            script: event.scriptName,
            url: (event.event as TraceItemFetchEventInfo)?.request?.url,
            colo: (event.event as TraceItemFetchEventInfo)?.request?.cf?.colo,
            // "cf-ray": (event.event as TraceItemFetchEventInfo)?.request.cf.ray,
          };
          return [
            // normal logs
            ...event.logs.map(log => ({
              ...context,
              ...JSON.parse(log.message[0]), // log.message is array
              level: log.level,
              timestamp: log.timestamp,
            })),
            // exceptions as error logs
            ...event.exceptions.map(err => ({
              ...context,
              name: err.name,
              message: err.message,
              level: 'exception',
              timestamp: err.timestamp,
            })),
          ];
        })
      ),
    });
  },
} satisfies ExportedHandler<Env>;

export { SourceScraperDO };
export { ProcessArticles } from './workflows/processArticles.workflow';
