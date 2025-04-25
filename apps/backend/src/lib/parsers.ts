import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { ok, err, Result } from 'neverthrow';

const rssFeedSchema = z.object({
  title: z.string().min(1),
  link: z.string(),
  pubDate: z.date().nullable(),
});

function cleanString(text: string) {
  return text
    .replace(/[ \t]+/g, ' ') // collapse spaces/tabs
    .replace(/\n\s+/g, '\n') // clean spaces after newlines
    .replace(/\s+\n/g, '\n') // clean spaces before newlines
    .replace(/\n{3,}/g, '\n\n') // keep max 2 consecutive newlines
    .trim(); // clean edges
}

function cleanUrl(url: string) {
  const u = new URL(url);

  const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
  paramsToRemove.forEach(param => u.searchParams.delete(param));

  return u.toString();
}

/**
 * Parses an RSS/XML feed content to extract article information
 *
 * Handles various RSS feed formats and structures while normalizing the output.
 * Extracts titles, links, and publication dates from the feed items.
 *
 * @param xml The XML content of the RSS feed as a string
 * @returns A Result containing either an array of parsed feed items or an error
 */
export async function parseRSSFeed(xml: string): Promise<Result<z.infer<typeof rssFeedSchema>[], Error>> {
  const safeParser = Result.fromThrowable(
    (xml: string) => new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml),
    e => (e instanceof Error ? e : new Error(String(e)))
  );

  const parsedXml = safeParser(xml);
  if (parsedXml.isErr()) {
    return err(new Error(`Parse error: ${parsedXml.error.message}`));
  }

  const result = parsedXml.value;

  // handle various feed structures
  let items = result.rss?.channel?.item || result.feed?.entry || result.item || result['rdf:RDF']?.item || [];

  // handle single item case
  items = Array.isArray(items) ? items : [items];

  const properItems = items.map((item: any) => {
    let title = '';
    let link = '';
    let id = '';
    let pubDateString: string | null = null;

    if (typeof item.title === 'string') {
      title = item.title;
    } else if (typeof item.title === 'object' && item.title['#text']) {
      title = item.title['#text'];
    } else {
      title = 'UNKNOWN';
    }

    if (typeof item.link === 'string') {
      link = item.link;
    } else if (typeof item.link === 'object' && item.link['@_href']) {
      link = item.link['@_href'];
    } else if (typeof item.guid === 'string') {
      link = item.guid;
    } else {
      link = 'UNKNOWN';
    }

    if (typeof item.guid === 'string') {
      id = item.guid;
    } else if (typeof item.guid === 'object' && item.guid['#text']) {
      id = item.guid['#text'];
    } else {
      id = 'UNKNOWN';
    }

    if (typeof item.pubDate === 'string') {
      pubDateString = item.pubDate;
    } else if (typeof item.published === 'string') {
      pubDateString = item.published;
    } else if (typeof item.updated === 'string') {
      pubDateString = item.updated;
    }

    let pubDate: Date | null = null;
    if (pubDateString) {
      pubDate = new Date(pubDateString);
      if (isNaN(pubDate.getTime())) {
        pubDate = null;
      }
    }

    return {
      title: cleanString(title),
      link: cleanUrl(cleanString(link)),
      id: cleanString(id),
      pubDate,
    };
  });

  // standardize the items
  const parsedItems = z.array(rssFeedSchema).safeParse(properItems);
  if (parsedItems.success === false) {
    return err(new Error(`Validation error: ${parsedItems.error.message}`));
  }

  return ok(parsedItems.data);
}

/**
 * Parses HTML content to extract article text and metadata
 *
 * Uses Mozilla Readability to identify and extract the main content
 * from an HTML document, ignoring navigation, ads, and other non-content elements.
 *
 * @param opts Object containing the HTML content to parse
 * @returns A Result containing either the parsed article data or an error object
 */
export function parseArticle(opts: { html: string }) {
  const safeReadability = Result.fromThrowable(
    (html: string) => new Readability(parseHTML(html).document).parse(),
    e => (e instanceof Error ? e : new Error(String(e)))
  );

  const articleResult = safeReadability(opts.html);
  if (articleResult.isErr()) {
    return err({ type: 'READABILITY_ERROR', error: articleResult.error });
  }

  // if we can't parse the article or there is no article, not much we can do
  const article = articleResult.value;
  if (article === null || !article.title || !article.textContent) {
    return err({ type: 'NO_ARTICLE_FOUND', error: new Error('No article found') });
  }

  return ok({
    title: article.title,
    text: cleanString(article.textContent),
    publishedTime: article.publishedTime || undefined,
  });
}
