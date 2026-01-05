import { Effect } from 'effect'
import { FeatureService, ServicesLive } from '../../services'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')

  if (!id) {
    setResponseStatus(event, 400)
    return {
      success: false,
      error: { message: 'Feature ID is required' },
    }
  }

  const program = Effect.gen(function* () {
    const featureService = yield* FeatureService
    return yield* featureService.getFeature(id)
  }).pipe(Effect.provide(ServicesLive))

  try {
    const feature = await Effect.runPromise(program)
    return { success: true, data: feature }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    const isNotFound =
      error && typeof error === 'object' && '_tag' in error
        ? (error as { _tag: string })._tag === 'FeatureNotFoundError'
        : false

    setResponseStatus(event, isNotFound ? 404 : 500)
    return {
      success: false,
      error: { message: errorMessage },
    }
  }
})
