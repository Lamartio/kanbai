# CLAUDE.md - AI Assistant Guidelines

This file provides context and guidelines for AI assistants working on the Kanbai project.

## Project Summary

Kanbai is a Kanban-style project management UI that enables a human project manager to orchestrate AI developer agents through conversations with an AI Business Analyst. Features are tracked as markdown files.

## Tech Stack Quick Reference

- **Runtime**: Bun (not Node.js)
- **Framework**: Nuxt 4
- **UI**: Nuxt UI (Tailwind-based components)
- **Content**: Nuxt Content (markdown with frontmatter)
- **Logic**: Effect-TS (functional effects, layers, services)
- **AI**: Effect AI for LLM integration

## Key Commands

```bash
# Development
bun run dev          # Start development server
bun run build        # Build for production
bun run preview      # Preview production build

# Testing
bun run test         # Run tests
bun run typecheck    # TypeScript type checking

# Linting
bun run lint         # Run ESLint
bun run lint:fix     # Fix linting issues
```

## Architecture Patterns

### Effect-TS Services Pattern

All business logic should be implemented as Effect-TS services with proper layering:

```typescript
// Define service interface
class StorageService extends Context.Tag("StorageService")<
  StorageService,
  {
    readonly createFeature: (data: FeatureData) => Effect.Effect<Feature, StorageError>
    readonly updateFeature: (id: string, data: Partial<FeatureData>) => Effect.Effect<Feature, StorageError>
    readonly deleteFeature: (id: string) => Effect.Effect<void, StorageError>
  }
>() {}

// Implement with layer
const StorageServiceLive = Layer.succeed(
  StorageService,
  StorageService.of({
    createFeature: (data) => Effect.gen(function* () {
      // Implementation
    }),
    // ...
  })
)
```

### Actions Pattern

Actions are typed objects sent from client to server:

```typescript
// Define action schemas with @effect/schema
const CreateFeatureAction = Schema.Struct({
  _tag: Schema.Literal("CreateFeature"),
  projectPrefix: Schema.String,
  title: Schema.String,
  description: Schema.String,
  tags: Schema.Array(Schema.String),
})

// Handle in server API
export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  return Effect.gen(function* () {
    const action = yield* Schema.decodeUnknown(ActionSchema)(body)
    // Process action...
  }).pipe(
    Effect.provide(ServicesLive),
    Effect.runPromise
  )
})
```

### Feature File Format

Features are markdown files in `content/` with this structure:

```markdown
---
id: PROJECT-001
title: Feature Title
tags:
  - TODO
  - tag-name
created: 2024-01-05T10:00:00Z
updated: 2024-01-05T10:00:00Z
assignee: null
---

# Feature Title

## Description
[Feature description from BA conversation]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Technical Notes
[Notes added during implementation]

## Conversation Log
[Automated log of BA conversation]
```

### Feature ID Generation

```typescript
// Generate next feature ID
const generateFeatureId = (prefix: string, existingIds: string[]): string => {
  const relevantIds = existingIds.filter(id => id.startsWith(prefix))
  const numbers = relevantIds.map(id => {
    const parts = id.split('-')
    return parseInt(parts[parts.length - 1], 10)
  })
  const nextNumber = Math.max(0, ...numbers) + 1
  return `${prefix}-${String(nextNumber).padStart(3, '0')}`
}
```

### Tag Validation

Tags must be URL-safe. Filter on input:

```typescript
const sanitizeTag = (tag: string): string =>
  tag.replace(/[^a-zA-Z0-9_-]/g, '')

const isValidTag = (tag: string): boolean =>
  /^[a-zA-Z0-9_-]+$/.test(tag)
```

## Directory Structure

```
server/
├── api/
│   ├── actions.post.ts     # Main action endpoint
│   └── features/           # Feature-specific endpoints
├── services/
│   ├── index.ts            # Service exports & main layer
│   ├── storage.ts          # File system operations
│   ├── feature.ts          # Feature CRUD operations
│   ├── ai.ts               # AI integration (Effect AI)
│   └── errors.ts           # Error types
└── utils/
    ├── id.ts               # ID generation utilities
    └── tags.ts             # Tag validation utilities
```

## MCP Servers Available

When working on this project, these MCP servers provide additional context:

1. **effect-mcp** - Use for Effect-TS patterns, Schema definitions, Layer composition
2. **Nuxt MCP** - Use for Nuxt 4 APIs, composables, server routes
3. **Nuxt UI MCP** - Use for component APIs, theming, form handling
4. **Playwright MCP** - Use for E2E testing, browser automation
5. **Context7** - Use for retrieving documentation context

## Common Tasks

### Adding a New Action Type

1. Define schema in `server/services/actions/schemas.ts`
2. Add handler in `server/services/actions/handlers.ts`
3. Update union type in `server/services/actions/index.ts`
4. Add client-side action creator in `composables/useActions.ts`

### Adding a New Service

1. Create service file in `server/services/`
2. Define `Context.Tag` for the service
3. Implement `Layer` for the service
4. Add to main `ServicesLive` layer in `server/services/index.ts`

### Creating UI Components

Use Nuxt UI components. Check the Nuxt UI MCP for component APIs:

```vue
<template>
  <UCard>
    <template #header>
      <h3>{{ feature.title }}</h3>
    </template>
    <UBadge v-for="tag in feature.tags" :key="tag">{{ tag }}</UBadge>
  </UCard>
</template>
```

## Environment

- **OS**: Linux
- **Runtime**: Bun (managed via mise)
- **Browser**: Chrome required for Playwright tests (install with `bunx playwright install chromium`)

## Do's and Don'ts

### Do
- Use Effect-TS for all server-side logic
- Use `@effect/schema` for validation
- Keep markdown files human-readable
- Use Nuxt UI components for consistency
- Write type-safe code throughout

### Don't
- Don't use raw `fs` operations - use the StorageService
- Don't skip validation on actions
- Don't hardcode IDs - use the generation utility
- Don't modify feature files directly from components - use actions
- Don't use Node.js APIs directly - prefer Bun-compatible APIs
