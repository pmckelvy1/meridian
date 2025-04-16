import { z } from 'zod';
import { parseArticle } from './parsers';
import { err, ok } from 'neverthrow';
import { safeFetch, userAgents } from './utils';
import { Env } from '../index';

export const articleSchema = z.object({
  status: z.coerce.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })).optional(),
  result: z.string(),
});

export async function getArticleWithBrowser(env: Env, url: string) {
  const response = await safeFetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/content`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CLOUDFLARE_BROWSER_RENDERING_API_TOKEN}`,
      },
      body: JSON.stringify({
        url,
        userAgent: userAgents[Math.floor(Math.random() * userAgents.length)],
        setExtraHTTPHeaders: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'keep-alive',
          DNT: '1',
          'Accept-Language': 'en-US,en;q=0.5',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
        cookies: [],
        gotoOptions: {
          waitUntil: 'networkidle0',
          timeout: 30000,
          referer: 'https://www.google.com/',
        },
        viewport: {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          isLandscape: false,
        },
        rejectResourceTypes: ['image', 'media', 'font', 'websocket'],
        bestAttempt: true,
        // all of these are very brittle, like all script tag usage
        // this mostly works for now but good to revisit every once in a while
        addScriptTag: [
          // fixes date formatting to be in US English
          {
            content:
              "(() => { Object.defineProperty(Intl, 'DateTimeFormat', { \n    writable: true, \n    value: new Proxy(Intl.DateTimeFormat, { \n      construct: (target, args) => new target('en-US', Object.assign({}, args[1])) \n    })\n  }); })();",
          },
          // clicks on cookie consent buttons
          {
            content:
              "(() => { const cookieButtons = Array.from(document.querySelectorAll(\'button, a\')).filter(el => el.textContent.toLowerCase().includes(\'accept\') && (el.textContent.toLowerCase().includes(\'cookie\') || el.textContent.toLowerCase().includes(\'consent\'))); if(cookieButtons.length > 0) { cookieButtons[0].click(); } })();",
          },
          // try to remove paywalls
          {
            content:
              "(() => { const paywallElements = Array.from(document.querySelectorAll(\'div, section\')).filter(el => el.id.toLowerCase().includes(\'paywall\') || el.className.toLowerCase().includes(\'paywall\') || el.id.toLowerCase().includes(\'subscribe\') || el.className.toLowerCase().includes(\'subscribe\')); paywallElements.forEach(el => el.remove()); document.querySelectorAll(\'.modal, .modal-backdrop, body > div[style*=\"position: fixed\"]\').forEach(el => el.remove()); document.body.style.overflow = \'auto\'; })();",
          },
          // remove all script, style, iframe, .ad, .ads, .advertisement, [class*="social"], [id*="social"], .share, .comments, aside, nav, header:not(article header), footer:not(article footer), [role="complementary"], [role="banner"], [role="navigation"], form, .related, .recommended, .newsletter, .subscription
          {
            content:
              '(() => { document.querySelectorAll(\'script, style, iframe, .ad, .ads, .advertisement, [class*="social"], [id*="social"], .share, .comments, aside, nav, header:not(article header), footer:not(article footer), [role="complementary"], [role="banner"], [role="navigation"], form, .related, .recommended, .newsletter, .subscription\').forEach(el => el.remove()); })();',
          },
          // remove all attributes except href, src, alt, title
          {
            content:
              "(() => { const keepAttributes = [\'href\', \'src\', \'alt\', \'title\']; document.querySelectorAll(\'*\').forEach(el => { [...el.attributes].forEach(attr => { if (!keepAttributes.includes(attr.name.toLowerCase())) { el.removeAttribute(attr.name); }}); }); })();",
          },
          // remove all empty div, span, p, section, article
          {
            content:
              "(() => { function removeEmpty() { let removed = 0; document.querySelectorAll(\'div, span, p, section, article\').forEach(el => { if (!el.hasChildNodes() || el.textContent.trim() === \'\') { el.remove(); removed++; } }); return removed; } let pass; do { pass = removeEmpty(); } while(pass > 0); })();",
          },
          // remove all meta tags with only one attribute
          {
            content:
              "(() => { document.querySelectorAll(\'meta\').forEach(meta => { if (meta.attributes.length <= 1) { meta.remove(); } }); })();",
          },
        ],
        waitForSelector: {
          selector: 'article, .article, .content, .post, #article, main',
          timeout: 5000,
        },
      }),
    }
  );
  if (response.isErr()) {
    return err({ type: 'FETCH_ERROR', error: response.error });
  }

  const parsedPageContent = articleSchema.safeParse(await response.value.json());
  if (parsedPageContent.success === false) {
    return err({ type: 'VALIDATION_ERROR', error: parsedPageContent.error });
  }

  const articleResult = parseArticle({ html: parsedPageContent.data.result });
  if (articleResult.isErr()) {
    return err({ type: 'PARSE_ERROR', error: articleResult.error });
  }

  return ok(articleResult.value);
}

export async function getArticleWithFetch(url: string) {
  const response = await safeFetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
      Referer: 'https://www.google.com/',
    },
  });
  if (response.isErr()) {
    return err({ type: 'FETCH_ERROR', error: response.error });
  }

  const articleResult = parseArticle({ html: await response.value.text() });
  if (articleResult.isErr()) {
    return err({ type: 'PARSE_ERROR', error: articleResult.error });
  }

  return ok(articleResult.value);
}
