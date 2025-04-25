CREATE TYPE "public"."article_completeness" AS ENUM('COMPLETE', 'PARTIAL_USEFUL', 'PARTIAL_USELESS');--> statement-breakpoint
CREATE TYPE "public"."article_content_quality" AS ENUM('OK', 'LOW_QUALITY', 'JUNK');--> statement-breakpoint
CREATE TYPE "public"."article_status" AS ENUM('PENDING_FETCH', 'CONTENT_FETCHED', 'PROCESSED', 'SKIPPED_PDF', 'FETCH_FAILED', 'RENDER_FAILED', 'AI_ANALYSIS_FAILED', 'EMBEDDING_FAILED', 'R2_UPLOAD_FAILED');--> statement-breakpoint
CREATE TABLE "articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"publish_date" timestamp,
	"status" "article_status" DEFAULT 'PENDING_FETCH',
	"content_file_key" text,
	"language" text,
	"primary_location" text,
	"completeness" "article_completeness",
	"content_quality" "article_content_quality",
	"used_browser" boolean,
	"event_summary_points" jsonb,
	"thematic_keywords" jsonb,
	"topic_tags" jsonb,
	"key_entities" jsonb,
	"content_focus" jsonb,
	"embedding" vector(384),
	"fail_reason" text,
	"source_id" integer NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "articles_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "newsletter" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "newsletter_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"total_articles" integer NOT NULL,
	"total_sources" integer NOT NULL,
	"used_articles" integer NOT NULL,
	"used_sources" integer NOT NULL,
	"tldr" text,
	"clustering_params" jsonb,
	"model_author" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"scrape_frequency" integer DEFAULT 2 NOT NULL,
	"paywall" boolean DEFAULT false NOT NULL,
	"category" text NOT NULL,
	"last_checked" timestamp,
	CONSTRAINT "sources_url_unique" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embeddingIndex" ON "articles" USING hnsw ("embedding" vector_cosine_ops);