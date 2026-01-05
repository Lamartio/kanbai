import { Context, Effect, Layer } from 'effect'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { StorageError } from './errors'

/**
 * Storage service interface for file operations
 */
export class StorageService extends Context.Tag('StorageService')<
  StorageService,
  {
    readonly readFile: (path: string) => Effect.Effect<string, StorageError>
    readonly writeFile: (
      path: string,
      content: string,
    ) => Effect.Effect<void, StorageError>
    readonly deleteFile: (path: string) => Effect.Effect<void, StorageError>
    readonly listFiles: (
      directory: string,
      pattern?: RegExp,
    ) => Effect.Effect<string[], StorageError>
    readonly fileExists: (path: string) => Effect.Effect<boolean, StorageError>
  }
>() {}

/**
 * Create a live implementation of StorageService
 *
 * @param basePath - Base path for all file operations
 */
export const makeStorageServiceLive = (basePath: string) =>
  Layer.succeed(
    StorageService,
    StorageService.of({
      readFile: (path: string) =>
        Effect.tryPromise({
          try: () => fs.readFile(join(basePath, path), 'utf-8'),
          catch: (error) =>
            new StorageError({
              operation: 'read',
              path,
              cause: error,
            }),
        }),

      writeFile: (path: string, content: string) =>
        Effect.tryPromise({
          try: async () => {
            const fullPath = join(basePath, path)
            await fs.mkdir(join(basePath), { recursive: true })
            await fs.writeFile(fullPath, content, 'utf-8')
          },
          catch: (error) =>
            new StorageError({
              operation: 'write',
              path,
              cause: error,
            }),
        }),

      deleteFile: (path: string) =>
        Effect.tryPromise({
          try: () => fs.unlink(join(basePath, path)),
          catch: (error) =>
            new StorageError({
              operation: 'delete',
              path,
              cause: error,
            }),
        }),

      listFiles: (directory: string, pattern?: RegExp) =>
        Effect.tryPromise({
          try: async () => {
            const fullPath = join(basePath, directory)
            try {
              const files = await fs.readdir(fullPath)
              if (pattern) {
                return files.filter((f) => pattern.test(f))
              }
              return files
            } catch {
              // Directory doesn't exist yet
              return []
            }
          },
          catch: (error) =>
            new StorageError({
              operation: 'list',
              path: directory,
              cause: error,
            }),
        }),

      fileExists: (path: string) =>
        Effect.tryPromise({
          try: async () => {
            try {
              await fs.access(join(basePath, path))
              return true
            } catch {
              return false
            }
          },
          catch: (error) =>
            new StorageError({
              operation: 'read',
              path,
              cause: error,
            }),
        }),
    }),
  )
