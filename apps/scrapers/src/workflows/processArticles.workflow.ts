import getArticleAnalysisPrompt, { articleAnalysisSchema } from '../prompts/articleAnalysis.prompt';
import { $articles, and, eq, gte, inArray, isNull } from '@meridian/database';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { DomainRateLimiter } from '../lib/rateLimiter';
import { Env } from '../index';
import { err, ok } from 'neverthrow';
import { generateObject } from 'ai';
import { getArticleWithBrowser, getArticleWithFetch } from '../lib/puppeteer';
import { getDb } from '../lib/utils';
import { ResultAsync } from 'neverthrow';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from 'cloudflare:workers';

const TRICKY_DOMAINS = [
  'reuters.com',
  'nytimes.com',
  'politico.com',
  'science.org',
  'alarabiya.net',
  'reason.com',
  'telegraph.co.uk',
  'lawfaremedia',
  'liberation.fr',
  'france24.com',
];

const dbStepConfig: WorkflowStepConfig = {
  retries: { limit: 3, delay: '1 second', backoff: 'linear' },
  timeout: '5 seconds',
};

type ProcessArticlesParams = { articles_id: number[] };

export class ProcessArticles extends WorkflowEntrypoint<Env, ProcessArticlesParams> {
  async run(_event: WorkflowEvent<ProcessArticlesParams>, step: WorkflowStep) {
    const env = this.env;
    const db = getDb(env.DATABASE_URL);
    const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY, baseURL: env.GOOGLE_BASE_URL });

    const articles = await step.do('get articles', dbStepConfig, async () =>
      db
        .select({ id: $articles.id, url: $articles.url, title: $articles.title, publishedAt: $articles.publishDate })
        .from($articles)
        .where(
          and(
            // only process articles that haven't been processed yet
            isNull($articles.processedAt),
            // only process articles that have a publish date in the last 48 hours
            gte($articles.publishDate, new Date(new Date().getTime() - 48 * 60 * 60 * 1000)),
            // only articles that have not failed
            isNull($articles.failReason),
            // MAIN FILTER: only articles that need to be processed
            inArray($articles.id, _event.payload.articles_id)
          )
        )
    );

    // Create rate limiter with article processing specific settings
    const rateLimiter = new DomainRateLimiter<{ id: number; url: string; title: string; publishedAt: Date | null }>({
      maxConcurrent: 8,
      globalCooldownMs: 1000,
      domainCooldownMs: 5000,
    });

    // Process articles with rate limiting
    const articlesToProcess: Array<{ id: number; title: string; text: string; publishedTime?: string }> = [];
    const articleResults = await rateLimiter.processBatch(articles, step, async (article, domain) => {
      // Skip PDFs immediately
      if (article.url.toLowerCase().endsWith('.pdf')) {
        return { id: article.id, success: false, error: 'pdf' };
      }

      // This will contain either a successful result or a controlled error
      let result;
      try {
        result = await step.do(
          `scrape article ${article.id}`,
          { retries: { limit: 3, delay: '2 second', backoff: 'exponential' }, timeout: '2 minutes' },
          async () => {
            // During retries, let errors bubble up naturally
            if (TRICKY_DOMAINS.includes(domain)) {
              const browserResult = await getArticleWithBrowser(env, article.url);
              if (browserResult.isErr()) throw browserResult.error.error;
              return { id: article.id, success: true, html: browserResult.value };
            } else {
              const fetchResult = await getArticleWithFetch(article.url);
              if (!fetchResult.isErr()) {
                return { id: article.id, success: true, html: fetchResult.value };
              }

              // Fetch failed, try browser with jitter
              const jitterTime = Math.random() * 2500 + 500;
              await step.sleep(`jitter`, jitterTime);

              const browserResult = await getArticleWithBrowser(env, article.url);
              if (browserResult.isErr()) throw browserResult.error.error;
              return { id: article.id, success: true, html: browserResult.value };
            }
          }
        );
      } catch (error) {
        // After all retries failed, return a structured error
        result = {
          id: article.id,
          success: false,
          error: error instanceof Error ? error.message : String(error) || 'exhausted all retries',
        };
      }

      return result;
    });

    // Handle results
    for (const result of articleResults) {
      if (result.success && 'html' in result) {
        articlesToProcess.push({
          id: result.id,
          title: result.html.title,
          text: result.html.text,
          publishedTime: result.html.publishedTime,
        });
      } else {
        // update failed articles in DB with the fail reason
        await step.do(`update db for failed article ${result.id}`, dbStepConfig, async () =>
          db
            .update($articles)
            .set({ processedAt: new Date(), failReason: result.error ? String(result.error) : 'Unknown error' })
            .where(eq($articles.id, result.id))
        );
      }
    }

    // process with LLM
    const analysisResults = await Promise.allSettled(
      articlesToProcess.map(async article => {
        try {
          const articleAnalysis = await step.do(
            `analyze article ${article.id}`,
            { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' },
            async () => {
              const response = await generateObject({
                model: google('gemini-2.0-flash'),
                temperature: 0,
                prompt: getArticleAnalysisPrompt(article.title, article.text),
                schema: articleAnalysisSchema,
              });
              return response.object;
            }
          );
          await step.do(`update db for article ${article.id}`, dbStepConfig, async () =>
            db
              .update($articles)
              .set({
                processedAt: new Date(),
                content: article.text,
                title: article.title,
                language: articleAnalysis.language,
                primary_location: articleAnalysis.primary_location,
                completeness: articleAnalysis.completeness,
                content_quality: articleAnalysis.content_quality,
                event_summary_points: articleAnalysis.event_summary_points,
                thematic_keywords: articleAnalysis.thematic_keywords,
                topic_tags: articleAnalysis.topic_tags,
                key_entities: articleAnalysis.key_entities,
                content_focus: articleAnalysis.content_focus,
              })
              .where(eq($articles.id, article.id))
          );
          return { id: article.id, success: true };
        } catch (error) {
          await step.do(`mark article ${article.id} as failed in analysis`, dbStepConfig, async () =>
            db
              .update($articles)
              .set({
                processedAt: new Date(),
                failReason: `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
              })
              .where(eq($articles.id, article.id))
          );
          return { id: article.id, success: false, error };
        }
      })
    );

    console.log(
      `Processed ${articlesToProcess.length} articles: ${
        analysisResults.filter(
          (result): result is PromiseFulfilledResult<{ id: number; success: true }> =>
            result.status === 'fulfilled' && result.value.success
        ).length
      } succeeded, ${
        analysisResults.filter(
          result => result.status === 'rejected' || (result.status === 'fulfilled' && !result.value.success)
        ).length
      } failed`
    );
  }
}

// helper to start the workflow from elsewhere
export async function startProcessArticleWorkflow(env: Env, params: ProcessArticlesParams) {
  const workflow = await ResultAsync.fromPromise(env.PROCESS_ARTICLES.create({ id: crypto.randomUUID(), params }), e =>
    e instanceof Error ? e : new Error(String(e))
  );
  if (workflow.isErr()) return err(workflow.error);
  return ok(workflow.value);
}
