import { Effect } from 'effect'
import { FeatureService, ServicesLive } from '../../services'

export default defineEventHandler(async (event) => {
  const program = Effect.gen(function* () {
    const featureService = yield* FeatureService
    return yield* featureService.listFeatures()
  }).pipe(Effect.provide(ServicesLive))

  try {
    const features = await Effect.runPromise(program)
    return { success: true, data: features }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    setResponseStatus(event, 500)
    return {
      success: false,
      error: { message: errorMessage },
    }
  }
})
