ALTER TABLE "articles" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
CREATE INDEX "embeddingIndex" ON "articles" USING hnsw ("embedding" vector_cosine_ops);