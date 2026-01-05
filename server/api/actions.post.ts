import { Effect } from 'effect'
import { parseAction, handleAction } from '../services/actions'
import { ServicesLive } from '../services'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  const program = Effect.gen(function* () {
    const action = yield* parseAction(body)
    const result = yield* handleAction(action)
    return result
  }).pipe(Effect.provide(ServicesLive))

  try {
    const result = await Effect.runPromise(program)
    return { success: true, data: result }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'
    const errorTag =
      error && typeof error === 'object' && '_tag' in error
        ? (error as { _tag: string })._tag
        : 'UnknownError'

    setResponseStatus(event, 400)
    return {
      success: false,
      error: {
        type: errorTag,
        message: errorMessage,
      },
    }
  }
})
