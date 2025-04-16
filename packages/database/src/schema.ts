import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, serial, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

/**
 * Note: We use $ to denote the table objects
 * This frees up the uses of sources, articles, reports, etc as variables in the codebase
 **/

const articleCompletenessEnum = pgEnum('completeness', ['COMPLETE', 'PARTIAL_USEFUL', 'PARTIAL_USELESS']);
const articleContentQualityEnum = pgEnum('content_quality', ['OK', 'LOW_QUALITY', 'JUNK']);
const articleStatusEnum = pgEnum('status', [
  'PENDING_FETCH',
  'CONTENT_FETCHED',
  'PROCESSING',
  'PROCESSED',
  'FETCH_FAILED',
  'RENDER_FAILED',
  'PROCESS_FAILED',
]);

export const $sources = pgTable('sources', {
  id: serial('id').primaryKey(),
  url: text('url').notNull().unique(),
  name: text('name').notNull(),
  scrape_frequency: integer('scrape_frequency').notNull().default(2), // 1=hourly, 2=4hrs, 3=6hrs, 4=daily
  paywall: boolean('paywall').notNull().default(false),
  category: text('category').notNull(),
  lastChecked: timestamp('last_checked', { mode: 'date' }),
});

export const $articles = pgTable('articles', {
  id: serial('id').primaryKey(),

  title: text('title').notNull(),
  url: text('url').notNull().unique(),
  publishDate: timestamp('publish_date', { mode: 'date' }),
  status: articleStatusEnum().default('PENDING_FETCH'),

  content: text('content'),

  language: text('language'),
  primary_location: text('primary_location'),
  completeness: articleCompletenessEnum(),
  content_quality: articleContentQualityEnum(),
  event_summary_points: jsonb('event_summary_points'),
  thematic_keywords: jsonb('thematic_keywords'),
  topic_tags: jsonb('topic_tags'),
  key_entities: jsonb('key_entities'),
  content_focus: jsonb('content_focus'),

  failReason: text('fail_reason'),

  sourceId: integer('source_id')
    .references(() => $sources.id)
    .notNull(),

  processedAt: timestamp('processed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`),
});

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

  createdAt: timestamp('created_at', { mode: 'date' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const $newsletter = pgTable('newsletter', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`),
});
