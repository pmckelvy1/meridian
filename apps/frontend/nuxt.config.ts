import tailwindcss from '@tailwindcss/vite';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      link: [{ rel: 'icon', type: 'image/png', href: '/favicon.ico' }],
    },
  },

  colorMode: { classSuffix: '', preference: 'system', fallback: 'system' },
  compatibilityDate: '2025-03-01',
  css: ['~/assets/css/main.css'],

  devtools: { enabled: true },
  devServer: { host: '0.0.0.0' },

  modules: ['@nuxtjs/color-mode', 'nuxt-auth-utils'],

  nitro: { prerender: { autoSubfolderIndex: false } },

  routeRules: {
    // Cache the list of briefs for 1 hour on CDN, 15 mins in browser
    // Allow serving stale data for up to a day while revalidating
    '/api/briefs': {
      cache: {
        maxAge: 60 * 15, // 15 minutes browser cache
        staleMaxAge: 60 * 60 * 24, // 1 day stale-while-revalidate on CDN
      },
    },
    // Cache individual briefs for longer (assuming they don't change once published)
    // Cache for 1 day on CDN, 1 hour in browser
    '/api/briefs/**': {
      // Matches /api/briefs/some-slug, /api/briefs/another-slug etc.
      cache: {
        maxAge: 60 * 60, // 1 hour browser cache
        staleMaxAge: 60 * 60 * 24 * 7, // 1 week stale-while-revalidate on CDN
      },
    },
  },
  runtimeConfig: {
    database: { url: '' },
    mailerlite: { api_key: '', group_id: '' },
    public: { WORKER_API: 'http://localhost:8787' },
  },

  srcDir: 'src',

  vite: { plugins: [tailwindcss()] },
});