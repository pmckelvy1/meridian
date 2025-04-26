import { boolean, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, vector } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Note: We use $ to denote the table objects
 * This frees up the uses of sources, articles, reports, etc as variables in the codebase
 **/

export const articleStatusEnum = pgEnum('article_status', [
  'PENDING_FETCH',
  'CONTENT_FETCHED',
  'PROCESSED',
  'SKIPPED_PDF',

  'FETCH_FAILED',
  'RENDER_FAILED',
  'AI_ANALYSIS_FAILED',
  'EMBEDDING_FAILED',
  'R2_UPLOAD_FAILED',
  'SKIPPED_TOO_OLD',
]);
export const articleCompletenessEnum = pgEnum('article_completeness', [
  'COMPLETE',
  'PARTIAL_USEFUL',
  'PARTIAL_USELESS',
]);
export const articleContentQualityEnum = pgEnum('article_content_quality', ['OK', 'LOW_QUALITY', 'JUNK']);

export const $sources = pgTable('sources', {
  id: serial('id').primaryKey(),
  url: text('url').notNull().unique(),
  name: text('name').notNull(),
  scrape_frequency: integer('scrape_frequency').notNull().default(2), // 1=hourly, 2=4hrs, 3=6hrs, 4=daily
  paywall: boolean('paywall').notNull().default(false),
  category: text('category').notNull(),
  lastChecked: timestamp('last_checked', { mode: 'date' }),
  do_initialized_at: timestamp('do_initialized_at', { mode: 'date' }),
});

export const $articles = pgTable(
  'articles',
  {
    id: serial('id').primaryKey(),

    title: text('title').notNull(),
    url: text('url').notNull().unique(),
    publishDate: timestamp('publish_date', { mode: 'date' }),
    status: articleStatusEnum().default('PENDING_FETCH'),
    contentFileKey: text('content_file_key'),

    language: text('language'),
    primary_location: text('primary_location'),
    completeness: articleCompletenessEnum(),
    content_quality: articleContentQualityEnum(),
    used_browser: boolean('used_browser'),
    event_summary_points: jsonb('event_summary_points'),
    thematic_keywords: jsonb('thematic_keywords'),
    topic_tags: jsonb('topic_tags'),
    key_entities: jsonb('key_entities'),
    content_focus: jsonb('content_focus'),
    embedding: vector('embedding', { dimensions: 384 }),

    failReason: text('fail_reason'),

    sourceId: integer('source_id')
      .references(() => $sources.id)
      .notNull(),

    processedAt: timestamp('processed_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`),
  },
  table => [index('embeddingIndex').using('hnsw', table.embedding.op('vector_cosine_ops'))]
);

export const $reports = pgTable('reports', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull(),

  totalArticles: integer('total_articles').notNull(),
  totalSources: integer('total_sources').notNull(),

  usedArticles: integer('used_articles').notNull(),
  usedSources: integer('used_sources').notNull(),

  tldr: text('tldr'),

  clustering_params: jsonb('clustering_params'),

  model_author: text('model_author'),

  cycle_start: timestamp('cycle_start', { mode: 'date' }),
  cycle_end: timestamp('cycle_end', { mode: 'date' }),

  createdAt: timestamp('created_at', { mode: 'date' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const $newsletter = pgTable('newsletter', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`),
});
