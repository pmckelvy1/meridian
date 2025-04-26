import { $reports, getDb } from '@meridian/database';
import { Env } from '../index';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent, WorkflowStepConfig } from 'cloudflare:workers';
import { getEvents } from '../lib/events';
import { callLLM } from '../lib/llm';
import {
  processStory,
  getBriefPrompt,
  getTitlePrompt,
  getTldrPrompt,
  briefSystemPrompt,
  averagePool,
} from '../lib/helpers';
import { AutoTokenizer, AutoModel } from '@xenova/transformers';
import * as hdbscan from 'hdbscanjs';
import * as umap from 'umap-js';
import { err, ok, ResultAsync } from 'neverthrow';

// Constants
const BATCH_SIZE = 64;
const CLUSTERING_PARAMS = {
  umap: {
    n_neighbors: 5,
  },
  hdbscan: {
    epsilon: 0.0,
    min_samples: 2,
    min_cluster_size: 2,
  },
};

const dbStepConfig: WorkflowStepConfig = {
  retries: { limit: 3, delay: '1 second', backoff: 'linear' },
  timeout: '5 seconds',
};

// Initialize models
let tokenizer: any;
let model: any;

async function initializeModels() {
  if (!tokenizer || !model) {
    tokenizer = await AutoTokenizer.from_pretrained('intfloat/multilingual-e5-small');
    model = await AutoModel.from_pretrained('intfloat/multilingual-e5-small');
  }
}

interface Article {
  id: number;
  sourceId: number;
  url: string;
  title: string;
  publishDate: string;
  content: string;
  location: string;
  relevance: string;
  completeness: string;
  summary: string;
  text_to_embed: string;
  cluster?: number;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map(val => val / norm);
}

async function processEvents(date: string) {
  const { sources, events } = await getEvents(date);

  // Process events into DataFrame-like structure
  const articles: Article[] = events.map(event => ({
    id: event.id,
    sourceId: event.sourceId,
    url: event.url,
    title: event.title,
    publishDate: event.publishDate,
    content: event.content,
    location: event.location,
    relevance: event.relevance,
    completeness: event.completeness,
    summary: event.summary.split('EVENT:')[1]?.split('CONTEXT:')[0]?.trim() || event.summary,
    text_to_embed: `query: ${event.summary}`,
  }));

  // Generate embeddings
  await initializeModels();
  const allEmbeddings = [];

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batchTexts = articles.slice(i, i + BATCH_SIZE).map(a => a.text_to_embed);
    const batchDict = await tokenizer(batchTexts, { maxLength: 512, padding: true, truncation: true });

    const outputs = await model(batchDict);
    const embeddings = averagePool(outputs.lastHiddenState, batchDict.attentionMask);
    const normalizedEmbeddings = embeddings.map(normalizeVector);
    allEmbeddings.push(...normalizedEmbeddings);
  }

  // Apply UMAP and HDBSCAN
  const umapEmbeddings = new umap.UMAP({
    nNeighbors: CLUSTERING_PARAMS.umap.n_neighbors,
    nComponents: 10,
    minDist: 0.0,
  }).fit(allEmbeddings);

  const clusterer = new hdbscan.HDBSCAN({
    minClusterSize: CLUSTERING_PARAMS.hdbscan.min_cluster_size,
    minSamples: CLUSTERING_PARAMS.hdbscan.min_samples,
    clusterSelectionEpsilon: CLUSTERING_PARAMS.hdbscan.epsilon,
    metric: 'euclidean',
  });

  const clusterLabels = clusterer.fit(umapEmbeddings);

  // Add cluster labels to articles
  articles.forEach((article, i) => {
    article.cluster = clusterLabels[i];
  });

  return { sources, events, clusters: articles, clusterLabels };
}

async function generateBrief(clusters: any[], events: any[]) {
  // Process clusters into stories
  const clustersWithArticles = [];
  const uniqueClusters = new Set(clusters.map(article => article.cluster).filter(id => id !== -1));

  for (const clusterId of uniqueClusters) {
    const clusterArticles = clusters.filter(article => article.cluster === clusterId);
    const articleIds = clusterArticles.map(article => article.id);
    clustersWithArticles.push({
      cluster_id: clusterId,
      articles_ids: articleIds,
    });
  }

  // Sort clusters by size
  clustersWithArticles.sort((a, b) => b.articles_ids.length - a.articles_ids.length);

  // Process stories
  const cleanedClustersRaw = await Promise.all(clustersWithArticles.map(story => processStory(story, events)));

  // Process and clean clusters
  const cleanedClusters = [];
  for (let i = 0; i < clustersWithArticles.length; i++) {
    const base = clustersWithArticles[i];
    const res = cleanedClustersRaw[i][0];

    if (res.answer === 'single_story') {
      const articleIds = base.articles_ids.filter(id => !res.outliers?.includes(id));
      cleanedClusters.push({
        id: cleanedClusters.length,
        title: res.title,
        importance: res.importance,
        articles: articleIds,
      });
    } else if (res.answer === 'collection_of_stories') {
      for (const story of res.stories || []) {
        cleanedClusters.push({
          id: cleanedClusters.length,
          title: story.title,
          importance: story.importance,
          articles: story.articles,
        });
      }
    }
  }

  // Generate brief outline
  const outlineResponse = await callLLM({
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'system', content: briefSystemPrompt },
      { role: 'user', content: getBriefPrompt(cleanedClusters, '') },
    ],
    temperature: 0.0,
  });

  // Generate full brief
  const briefResponse = await callLLM({
    model: 'gemini-2.5-pro-preview-03-25',
    messages: [
      { role: 'system', content: briefSystemPrompt },
      { role: 'user', content: getBriefPrompt(cleanedClusters, outlineResponse[0]) },
    ],
    temperature: 0.0,
  });

  // Generate title
  const titleResponse = await callLLM({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: getTitlePrompt(briefResponse[0]) }],
    temperature: 0.0,
  });

  // Generate TL;DR
  const tldrResponse = await callLLM({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: getTldrPrompt(briefResponse[0]) }],
    temperature: 0.0,
  });

  return {
    title: titleResponse[0],
    content: briefResponse[0],
    tldr: tldrResponse[0],
    stories: cleanedClusters,
  };
}

// Main workflow class
export class GenerateReport extends WorkflowEntrypoint<Env, {}> {
  async run(_event: WorkflowEvent<{}>, step: WorkflowStep) {
    const db = getDb(this.env.DATABASE_URL);
    const date = new Date().toISOString().split('T')[0];

    try {
      // 1. Process events
      console.log('Processing events...');
      const processedData = await step.do('process_events', dbStepConfig, async () => {
        return processEvents(date);
      });

      // 2. Generate brief
      console.log('Generating brief...');
      const briefData = await step.do('generate_brief', dbStepConfig, async () => {
        return generateBrief(processedData.clusters, processedData.events);
      });

      // 3. Store report in database
      console.log('Storing report...');
      await step.do('store_report', dbStepConfig, async () => {
        const report = {
          title: briefData.title,
          content: briefData.content,
          totalArticles: processedData.events.length,
          totalSources: processedData.sources.length,
          usedArticles: briefData.stories.reduce((acc, story) => acc + story.articles.length, 0),
          usedSources: new Set(
            processedData.events
              .filter(e => briefData.stories.some(s => s.articles.includes(e.id)))
              .map(e => e.sourceId)
          ).size,
          tldr: briefData.tldr,
          model_author: 'gemini-2.5-pro-preview-03-25',
          clustering_params: CLUSTERING_PARAMS,
        };

        await db.insert($reports).values(report);
      });

      return { success: true };
    } catch (error) {
      console.error('Workflow error:', error);
      throw error;
    }
  }
}

// Helper to start the workflow from elsewhere
export async function startGenerateReportWorkflow(env: Env) {
  const workflow = await ResultAsync.fromPromise(env.GENERATE_REPORT.create({ id: crypto.randomUUID() }), e =>
    e instanceof Error ? e : new Error(String(e))
  );
  if (workflow.isErr()) {
    return err(workflow.error);
  }
  return ok(workflow.value);
}
