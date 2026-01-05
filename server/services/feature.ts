import { Context, Effect, Layer, pipe } from 'effect'
import { Schema } from 'effect'
import { StorageService } from './storage'
import {
  DuplicateFeatureError,
  FeatureNotFoundError,
  FeatureValidationError,
  type FeatureError,
} from './errors'
import { generateFeatureId, generateFilename } from '../utils/id'
import { ensureKanbanTag, processTags } from '../utils/tags'

/**
 * Feature frontmatter schema
 */
export const FeatureFrontmatter = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  tags: Schema.Array(Schema.String),
  created: Schema.String,
  updated: Schema.String,
  assignee: Schema.NullOr(Schema.String),
})

export type FeatureFrontmatter = typeof FeatureFrontmatter.Type

/**
 * Full feature including content
 */
export const Feature = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  tags: Schema.Array(Schema.String),
  created: Schema.String,
  updated: Schema.String,
  assignee: Schema.NullOr(Schema.String),
  content: Schema.String,
  filename: Schema.String,
})

export type Feature = typeof Feature.Type

/**
 * Data for creating a new feature
 */
export interface CreateFeatureData {
  projectPrefix: string
  title: string
  description: string
  acceptanceCriteria?: string[]
  tags?: string[]
}

/**
 * Data for updating a feature
 */
export interface UpdateFeatureData {
  title?: string
  tags?: string[]
  content?: string
  assignee?: string | null
}

/**
 * Parse frontmatter from markdown content
 */
const parseFrontmatter = (
  content: string,
): { frontmatter: Record<string, unknown>; body: string } => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const [, yamlContent, body] = match
  const frontmatter: Record<string, unknown> = {}

  // Simple YAML parsing for our use case
  const lines = yamlContent.split('\n')
  let currentKey = ''
  let currentArray: string[] | null = null

  for (const line of lines) {
    if (line.startsWith('  - ')) {
      // Array item
      if (currentArray) {
        currentArray.push(line.slice(4))
      }
    } else if (line.includes(':')) {
      // Save previous array if exists
      if (currentArray && currentKey) {
        frontmatter[currentKey] = currentArray
        currentArray = null
      }

      const [key, ...valueParts] = line.split(':')
      const value = valueParts.join(':').trim()
      currentKey = key.trim()

      if (value === '') {
        // Could be an array
        currentArray = []
      } else if (value === 'null') {
        frontmatter[currentKey] = null
      } else {
        frontmatter[currentKey] = value
      }
    }
  }

  // Save last array if exists
  if (currentArray && currentKey) {
    frontmatter[currentKey] = currentArray
  }

  return { frontmatter, body: body.trim() }
}

/**
 * Generate markdown content with frontmatter
 */
const generateMarkdown = (feature: {
  id: string
  title: string
  tags: string[]
  created: string
  updated: string
  assignee: string | null
  content: string
}): string => {
  const tagsYaml = feature.tags.map((t) => `  - ${t}`).join('\n')

  return `---
id: ${feature.id}
title: ${feature.title}
tags:
${tagsYaml}
created: ${feature.created}
updated: ${feature.updated}
assignee: ${feature.assignee ?? 'null'}
---

${feature.content}
`
}

/**
 * Feature service interface
 */
export class FeatureService extends Context.Tag('FeatureService')<
  FeatureService,
  {
    readonly listFeatures: () => Effect.Effect<Feature[], FeatureError>
    readonly getFeature: (id: string) => Effect.Effect<Feature, FeatureError>
    readonly createFeature: (
      data: CreateFeatureData,
    ) => Effect.Effect<Feature, FeatureError>
    readonly updateFeature: (
      id: string,
      data: UpdateFeatureData,
    ) => Effect.Effect<Feature, FeatureError>
    readonly deleteFeature: (id: string) => Effect.Effect<void, FeatureError>
    readonly moveFeature: (
      id: string,
      status: string,
    ) => Effect.Effect<Feature, FeatureError>
  }
>() {}

/**
 * Live implementation of FeatureService
 */
export const FeatureServiceLive = Layer.effect(
  FeatureService,
  Effect.gen(function* () {
    const storage = yield* StorageService

    const findFeatureFile = (id: string) =>
      pipe(
        storage.listFiles('', /\.md$/),
        Effect.flatMap((files) => {
          const file = files.find((f) => f.startsWith(id))
          if (!file) {
            return Effect.fail(new FeatureNotFoundError({ featureId: id }))
          }
          return Effect.succeed(file)
        }),
      )

    const parseFeatureFile = (filename: string) =>
      pipe(
        storage.readFile(filename),
        Effect.flatMap((content) => {
          const { frontmatter, body } = parseFrontmatter(content)
          return Effect.succeed({
            id: frontmatter.id as string,
            title: frontmatter.title as string,
            tags: (frontmatter.tags as string[]) || [],
            created: frontmatter.created as string,
            updated: frontmatter.updated as string,
            assignee: frontmatter.assignee as string | null,
            content: body,
            filename,
          })
        }),
      )

    return FeatureService.of({
      listFeatures: () =>
        pipe(
          storage.listFiles('', /\.md$/),
          Effect.flatMap((files) =>
            Effect.all(files.map((f) => parseFeatureFile(f))),
          ),
        ),

      getFeature: (id: string) =>
        pipe(findFeatureFile(id), Effect.flatMap(parseFeatureFile)),

      createFeature: (data: CreateFeatureData) =>
        Effect.gen(function* () {
          // Validate title
          if (!data.title.trim()) {
            return yield* Effect.fail(
              new FeatureValidationError({
                message: 'Title is required',
                field: 'title',
              }),
            )
          }

          // Get existing IDs
          const files = yield* storage.listFiles('', /\.md$/)
          const existingIds = files.map((f) => f.split('-').slice(0, -1).join('-'))

          // Generate new ID
          const id = generateFeatureId(data.projectPrefix, existingIds)

          // Check for duplicates
          const exists = yield* storage.fileExists(
            generateFilename(id, data.title),
          )
          if (exists) {
            return yield* Effect.fail(new DuplicateFeatureError({ featureId: id }))
          }

          // Process tags
          const tags = ensureKanbanTag(processTags(data.tags || []))

          // Generate content
          const now = new Date().toISOString()
          const acceptanceCriteria = data.acceptanceCriteria?.length
            ? `## Acceptance Criteria\n${data.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}`
            : ''

          const content = `# ${data.title}

## Description
${data.description}

${acceptanceCriteria}

## Technical Notes

## Conversation Log
`

          const feature = {
            id,
            title: data.title,
            tags,
            created: now,
            updated: now,
            assignee: null,
            content,
            filename: generateFilename(id, data.title),
          }

          // Write file
          yield* storage.writeFile(
            feature.filename,
            generateMarkdown(feature),
          )

          return feature
        }),

      updateFeature: (id: string, data: UpdateFeatureData) =>
        Effect.gen(function* () {
          const filename = yield* findFeatureFile(id)
          const current = yield* parseFeatureFile(filename)

          const updated = {
            ...current,
            title: data.title ?? current.title,
            tags: data.tags ? ensureKanbanTag(processTags(data.tags)) : current.tags,
            content: data.content ?? current.content,
            assignee: data.assignee !== undefined ? data.assignee : current.assignee,
            updated: new Date().toISOString(),
          }

          // If title changed, we might need a new filename
          const newFilename =
            data.title && data.title !== current.title
              ? generateFilename(id, data.title)
              : filename

          // Write updated content
          yield* storage.writeFile(newFilename, generateMarkdown(updated))

          // Delete old file if filename changed
          if (newFilename !== filename) {
            yield* storage.deleteFile(filename)
          }

          return { ...updated, filename: newFilename }
        }),

      deleteFeature: (id: string) =>
        pipe(
          findFeatureFile(id),
          Effect.flatMap((filename) => storage.deleteFile(filename)),
        ),

      moveFeature: (id: string, status: string) =>
        Effect.gen(function* () {
          const filename = yield* findFeatureFile(id)
          const current = yield* parseFeatureFile(filename)

          // Update status tag
          const filteredTags = current.tags.filter(
            (t) => !['TODO', 'DOING', 'REVIEWING', 'DONE'].includes(t),
          )
          const newTags = [status, ...filteredTags]

          const updated = {
            ...current,
            tags: newTags,
            updated: new Date().toISOString(),
          }

          yield* storage.writeFile(filename, generateMarkdown(updated))

          return updated
        }),
    })
  }),
)
