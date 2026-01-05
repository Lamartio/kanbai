// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-05',

  future: {
    compatibilityVersion: 4,
  },

  modules: [
    '@nuxt/ui',
    '@nuxt/content',
    '@nuxt/eslint',
  ],

  css: ['~/assets/css/main.css'],

  content: {
    // Enable document-driven mode for feature files
    documentDriven: false,
  },

  devtools: { enabled: true },

  // Server-side rendering
  ssr: true,

  // TypeScript configuration
  typescript: {
    strict: true,
    typeCheck: false, // Run manually with `bun run typecheck`
  },

  // Runtime config
  runtimeConfig: {
    // Server-only keys
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    // Public keys (exposed to client)
    public: {
      aiModel: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    },
  },
})
