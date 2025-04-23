ALTER TABLE "articles" ALTER COLUMN "completeness" SET DATA TYPE completeness;--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "content_quality" SET DATA TYPE content_quality;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "status" "status" DEFAULT 'PENDING_FETCH';--> statement-breakpoint
ALTER TABLE "articles" DROP COLUMN "content";