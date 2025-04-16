# Meridian Scrapers & Processors Worker (`@meridian/scrapers`)

This Cloudflare Worker application is a core component of the Meridian project, responsible for the data ingestion and initial processing pipeline. It fetches RSS feeds from various sources, extracts article metadata, orchestrates the scraping of full article content using different strategies, triggers AI analysis via Google Gemini, and provides API endpoints for the frontend and potentially other services.

It leverages several Cloudflare platform features for resilience and scalability:

- **Durable Objects (`SourceScraperDO`):** Manages the state and scheduled fetching for individual news sources.
- **Queues (`ARTICLE_PROCESSING_QUEUE`):** Decouples the initial RSS check from the more intensive article processing.
- **Workflows (`ProcessArticles`):** Provides durable, multi-step execution for scraping and analyzing article content, handling retries automatically.
- **Workers:** Runs the Hono API server, queue consumer logic, and Workflow triggers.

## Key Components

1.  **Hono API Server (`app.ts`):**

    - Provides HTTP endpoints for fetching processed events (`/events`), managing reports (`/reports`), managing sources (`/sources`), generating OpenGraph images (`/openGraph`), and internal operations.
    - Handles routing requests to specific `SourceScraperDO` instances (`/do/source/...`).
    - Includes an administrative endpoint (`/admin/initialize-dos`) to bootstrap Durable Objects from the database.
    - Uses JWT or Bearer Token authentication (`MERIDIAN_SECRET_KEY`) for protected routes.

2.  **Source Scraper Durable Object (`SourceScraperDO`):**

    - One instance per news source URL.
    - Uses Cloudflare Alarms to schedule periodic RSS feed checks based on the source's configured frequency.
    - Fetches and parses RSS feeds using `fast-xml-parser`.
    - Identifies new articles based on URL and publish date.
    - Inserts basic article metadata (URL, title, source ID, publish date) into the database.
    - Sends the IDs of newly inserted articles to the `ARTICLE_PROCESSING_QUEUE`.
    - Implements robust retries with backoff for fetching, parsing, and DB insertion steps.
    - Stores its state (source ID, URL, frequency, last checked time) in Durable Object storage.

3.  **Article Processing Queue:**

    - Receives messages containing batches of article IDs that need full content scraping and analysis.
    - The queue consumer (`queue` handler in `index.ts`) aggregates IDs from the batch.
    - Triggers the `ProcessArticles` Workflow to handle the actual processing.
    - Configured with a Dead Letter Queue (`article-processing-dlq`) for messages that fail persistently.

4.  **Process Articles Workflow (`ProcessArticles`):**

    - Receives a list of article IDs from the queue consumer.
    - Fetches article details (URL, title) from the database.
    - Uses a `DomainRateLimiter` to manage scraping politeness across different domains.
    - Scrapes full article content:
      - Attempts direct `fetch` first.
      - Falls back to the Cloudflare Browser Rendering REST API for tricky domains or initial fetch failures, using Puppeteer-like interactions defined via the API.
    - Uses `@mozilla/readability` to extract the core article text from the HTML.
    - Sends the extracted title and text to Google Gemini via `@ai-sdk/google` for structured analysis (summarization, keyword extraction, classification) using a detailed prompt and schema.
    - Updates the corresponding articles in the database with the full content and AI analysis results, or marks them with a `failReason` if processing failed.
    - Leverages Workflow steps (`step.do`, `step.sleep`) for automatic retries and durable execution.

5.  **Integrations:**
    - **Database (`@meridian/database`):** Uses Drizzle ORM and `postgres.js` to interact with the PostgreSQL database via Cloudflare Hyperdrive (if configured) or a direct connection string.
    - **Cloudflare Browser Rendering API:** Used as a fallback mechanism to scrape content from websites that are difficult to parse with simple fetch requests (e.g., heavy JavaScript, paywalls).
    - **Google AI (Gemini):** Used for the core article analysis and structuring task.

## How It Works (High-Level Flow)

1.  **Initialization:** The `/admin/initialize-dos` endpoint is called (manually or via automation) to create/update `SourceScraperDO` instances for each source in the database.
2.  **Scheduled Fetch:** A `SourceScraperDO` instance's alarm triggers based on its configured frequency.
3.  **RSS Processing:** The DO fetches its assigned RSS feed, parses it, compares entries against the database (implicitly via `ON CONFLICT DO NOTHING`), and identifies new articles.
4.  **DB Insert & Queue:** The DO inserts basic metadata for new articles into the `articles` table and sends their database IDs to the `ARTICLE_PROCESSING_QUEUE`.
5.  **Queue Consumption:** The Worker's `queue` handler receives a batch of article IDs.
6.  **Workflow Trigger:** The `queue` handler triggers the `ProcessArticles` Workflow, passing the batch of article IDs.
7.  **Content Scraping:** The Workflow fetches article details from the DB and scrapes the full content from the web using the rate limiter and appropriate method (fetch or Browser Rendering).
8.  **AI Analysis:** The Workflow sends the extracted content to Google Gemini for analysis.
9.  **DB Update:** The Workflow updates the articles in the database with the scraped content and the structured analysis results from the AI.
10. **API Access:** The Hono API server allows the frontend or other services to query the processed data (e.g., via `/events`).

## Configuration

Configuration is managed through `wrangler.jsonc` and environment variables/secrets.

### Environment Variables & Secrets

The following variables need to be set (e.g., in a `.env` file for local development or as secrets in Cloudflare for production):

- `DATABASE_URL`: The connection string for your PostgreSQL database.
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID (used for Browser Rendering API).
- `CLOUDFLARE_BROWSER_RENDERING_API_TOKEN`: An API token with permissions for Browser Rendering. Create via Cloudflare Dashboard -> My Profile -> API Tokens.
- `GOOGLE_API_KEY`: Your API key for Google AI Studio / Vertex AI.
- `GOOGLE_BASE_URL`: (Optional) Base URL for Google AI if using a proxy or specific endpoint.
- `MERIDIAN_SECRET_KEY`: A secret key used for Bearer token authentication on protected API routes.

**Note:** For production deployments (`wrangler deploy`), use Wrangler secrets (`npx wrangler secret put <NAME>`) instead of `.env` files.

### `wrangler.jsonc`

Ensure the following bindings are correctly configured:

- **Durable Objects (`durable_objects`):**
  - Binding for `SOURCE_SCRAPER` linked to the `SourceScraperDO` class.
  - `migrations` block defining the `SourceScraperDO` class.
- **Queues (`queues`):**
  - Producer binding for `ARTICLE_PROCESSING_QUEUE`.
  - Consumer configuration for `article-processing-queue` pointing to the Worker's `queue` handler, including settings like `dead_letter_queue`.
- **Workflows (`workflows`):**
  - Binding for `PROCESS_ARTICLES` linked to the `ProcessArticles` class.
  - (Potentially `SCRAPE_RSS_FEED` if used).
- **Variables (`vars`):**
  - `CORS_ORIGIN`: Define allowed origins for CORS (use environment overrides for production).
- **Hyperdrive (`hyperdrive`):**
  - _(Optional)_ If using Hyperdrive, add the binding configuration here.

## Running Locally

1.  Ensure you have Node.js, pnpm, and Wrangler installed.
2.  Navigate to the monorepo root.
3.  Install dependencies: `pnpm install`
4.  Ensure the `@meridian/database` package has its `.env` configured and migrations have been run (`pnpm --filter @meridian/database migrate`).
5.  Create a `.env` file in `apps/scrapers` or the monorepo root and populate the required environment variables listed above.
6.  Run the development server: `pnpm --filter @meridian/scrapers run dev`
    - This uses `wrangler dev --local`.
    - You may need a tool like `cloudflared tunnel` if your local database isn't publicly accessible.
    - Local emulation for Workflows and Queues might have limitations compared to the deployed environment.
7.  **Crucially:** You will likely need to manually hit the `/admin/initialize-dos` endpoint once (e.g., via `curl` or a browser) to create and initialize the `SourceScraperDO` instances based on your database sources. Remember to secure this endpoint before production.

## Deployment

Deployment is typically handled via Wrangler:

1.  Ensure `wrangler.jsonc` is configured correctly for the target environment (e.g., using the `env.production` block).
2.  Set production secrets using `npx wrangler secret put <SECRET_NAME>`.
3.  Run `wrangler deploy` from the `apps/scrapers` directory, or use the monorepo's build/deploy scripts.
