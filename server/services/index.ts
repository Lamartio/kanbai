import { Layer } from 'effect'
import { join } from 'node:path'
import { makeStorageServiceLive, StorageService } from './storage'
import { FeatureService, FeatureServiceLive } from './feature'

// Re-export services and types
export { StorageService } from './storage'
export { FeatureService, type Feature, type CreateFeatureData, type UpdateFeatureData } from './feature'
export * from './errors'

/**
 * Get the content directory path
 * In development, this is relative to the project root
 */
const getContentPath = () => {
  // Use process.cwd() to get the project root
  return join(process.cwd(), 'content')
}

/**
 * Storage layer configured for the content directory
 */
export const StorageServiceLive = makeStorageServiceLive(getContentPath())

/**
 * Combined services layer
 * Provides all services needed for the application
 */
export const ServicesLive = Layer.mergeAll(
  StorageServiceLive,
  FeatureServiceLive.pipe(Layer.provide(StorageServiceLive)),
)

/**
 * Helper to run an Effect with all services
 */
export const runWithServices = <A, E>(
  effect: import('effect').Effect.Effect<A, E, FeatureService | StorageService>,
) =>
  import('effect').Effect.runPromise(
    effect.pipe(import('effect').Effect.provide(ServicesLive)),
  )
