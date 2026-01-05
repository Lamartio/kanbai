import { defineContentConfig, defineCollection, z } from '@nuxt/content'

export default defineContentConfig({
  collections: {
    features: defineCollection({
      type: 'page',
      source: '*.md',
      schema: z.object({
        id: z.string(),
        title: z.string(),
        tags: z.array(z.string()).default(['TODO']),
        created: z.string().optional(),
        updated: z.string().optional(),
        assignee: z.string().nullable().optional(),
      }),
    }),
  },
})
