ALTER TABLE "articles" RENAME COLUMN "location" TO "primary_location";--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "content_quality" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "event_summary_points" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "thematic_keywords" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "topic_tags" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "key_entities" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "content_focus" jsonb;--> statement-breakpoint
ALTER TABLE "articles" DROP COLUMN "relevance";--> statement-breakpoint
ALTER TABLE "articles" DROP COLUMN "summary";