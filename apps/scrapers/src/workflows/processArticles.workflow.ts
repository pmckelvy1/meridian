import getArticleAnalysisPrompt, { articleAnalysisSchema } from '../prompts/articleAnalysis.prompt';
import { $articles, and, eq, gte, isNull, sql } from '@meridian/database';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { Env } from '../index';
import { generateObject } from 'ai';
import { getArticleWithBrowser, getArticleWithFetch } from '../lib/puppeteer';
import { getDb } from '../lib/utils';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from 'cloudflare:workers';
import { err, ok } from 'neverthrow';
import { ResultAsync } from 'neverthrow';
import { DomainRateLimiter } from '../lib/rateLimiter';

const dbStepConfig: WorkflowStepConfig = {
  retries: { limit: 3, delay: '1 second', backoff: 'linear' },
  timeout: '5 seconds',
};

// Main workflow class
export class ProcessArticles extends WorkflowEntrypoint<Env, Params> {
  async run(_event: WorkflowEvent<Params>, step: WorkflowStep) {
    const env = this.env;
    const db = getDb(env.DATABASE_URL);
    const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY, baseURL: env.GOOGLE_BASE_URL });

    async function getUnprocessedArticles(opts: { limit?: number }) {
      const articles = await db
        .select({
          id: $articles.id,
          url: $articles.url,
          title: $articles.title,
          publishedAt: $articles.publishDate,
        })
        .from($articles)
        .where(
          and(
            // only process articles that haven't been processed yet
            isNull($articles.processedAt),
            // only process articles that have a publish date in the last 48 hours
            gte($articles.publishDate, new Date(new Date().getTime() - 48 * 60 * 60 * 1000)),
            // only articles that have not failed
            isNull($articles.failReason)
          )
        )
        .limit(opts.limit ?? 100)
        .orderBy(sql`RANDOM()`);
      return articles;
    }

    // get articles to process
    const articles = await step.do('get articles', dbStepConfig, async () => getUnprocessedArticles({ limit: 200 }));

    // Process articles in batches until no more articles are found
    let hasMoreArticles = true;
    while (hasMoreArticles) {
      // Create rate limiter with article processing specific settings
      const rateLimiter = new DomainRateLimiter<{
        id: number;
        url: string;
        title: string;
        publishedAt: Date | null;
      }>({
        maxConcurrent: 8,
        globalCooldownMs: 1000,
        domainCooldownMs: 5000,
      });

      const articlesToProcess: Array<{
        id: number;
        title: string;
        text: string;
        publishedTime?: string;
      }> = [];

      const trickyDomains = [
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

      // Process articles with rate limiting
      const articleResults = await rateLimiter.processBatch(articles, step, async (article, domain) => {
        // Skip PDF files immediately
        if (article.url.toLowerCase().endsWith('.pdf')) {
          return { id: article.id, success: false, error: 'pdf' };
        }

        const result = await step.do(
          `scrape article ${article.id}`,
          {
            retries: { limit: 3, delay: '2 second', backoff: 'exponential' },
            timeout: '1 minute',
          },
          async () => {
            // start with light scraping
            let articleData: { title: string; text: string; publishedTime: string | undefined } | undefined = undefined;

            // if we're from a tricky domain, fetch with browser first
            if (trickyDomains.includes(domain)) {
              const articleResult = await getArticleWithBrowser(env, article.url);
              if (articleResult.isErr()) {
                return { id: article.id, success: false, error: articleResult.error.error };
              }
              articleData = articleResult.value;
            }

            // otherwise, start with fetch & then browser if that fails
            const lightResult = await getArticleWithFetch(article.url);
            if (lightResult.isErr()) {
              // rand jitter between .5 & 3 seconds
              const jitterTime = Math.random() * 2500 + 500;
              await step.sleep(`jitter`, jitterTime);

              const articleResult = await getArticleWithBrowser(env, article.url);
              if (articleResult.isErr()) {
                return { id: article.id, success: false, error: articleResult.error.error };
              }

              articleData = articleResult.value;
            } else articleData = lightResult.value;

            return { id: article.id, success: true, html: articleData };
          }
        );

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
          await step.do(`update db for failed article ${result.id}`, dbStepConfig, async () => {
            await db
              .update($articles)
              .set({
                processedAt: new Date(),
                failReason: result.error ? String(result.error) : 'Unknown error',
              })
              .where(eq($articles.id, result.id));
          });
        }
      }

      // process with LLM
      await Promise.all(
        articlesToProcess.map(async article => {
          const articleAnalysis = await step.do(
            `analyze article ${article.id}`,
            {
              retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' },
              timeout: '1 minute',
            },

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

          // update db
          await step.do(`update db for article ${article.id}`, dbStepConfig, async () => {
            await db
              .update($articles)
              .set({
                processedAt: new Date(),
                content: article.text,
                title: article.title,
                completeness: articleAnalysis.completeness,
                relevance: articleAnalysis.relevance,
                language: articleAnalysis.language,
                location: articleAnalysis.location,
                summary: (() => {
                  if (articleAnalysis.summary === undefined) return null;
                  let txt = '';
                  txt += `HEADLINE: ${articleAnalysis.summary.headline.trim()}\n`;
                  txt += `ENTITIES: ${articleAnalysis.summary.entities.join(', ')}\n`;
                  txt += `EVENT: ${articleAnalysis.summary.event.trim()}\n`;
                  txt += `CONTEXT: ${articleAnalysis.summary.context.trim()}\n`;
                  return txt.trim();
                })(),
              })
              .where(eq($articles.id, article.id))
              .execute();
          });
        })
      );

      console.log(`Processed ${articlesToProcess.length} articles`);

      // Check if there are more articles to process
      const remainingArticles = await step.do('get remaining articles', dbStepConfig, async () =>
        getUnprocessedArticles({ limit: 100 })
      );

      if (remainingArticles.length === 0) {
        hasMoreArticles = false;
        console.log('No more articles to process');
      } else {
        console.log(`Found ${remainingArticles.length} remaining articles to process`);
        // Update articles array for next iteration
        articles.length = 0;
        articles.push(...remainingArticles);
      }
    }
  }
}

// helper to start the workflow from elsewhere
export async function startProcessArticleWorkflow(env: Env) {
  const workflow = await ResultAsync.fromPromise(env.PROCESS_ARTICLES.create({ id: crypto.randomUUID() }), e =>
    e instanceof Error ? e : new Error(String(e))
  );
  if (workflow.isErr()) {
    return err(workflow.error);
  }
  return ok(workflow.value);
}
