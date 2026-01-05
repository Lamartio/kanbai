import { Effect, Schema } from 'effect'
import {
  FeatureService,
  type CreateFeatureData,
  type UpdateFeatureData,
} from './feature'
import { ActionParseError, ActionHandlerError } from './errors'

/**
 * Create Feature Action
 */
export const CreateFeatureAction = Schema.Struct({
  _tag: Schema.Literal('CreateFeature'),
  projectPrefix: Schema.String,
  title: Schema.String,
  description: Schema.String,
  acceptanceCriteria: Schema.optional(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
})

/**
 * Update Feature Action
 */
export const UpdateFeatureAction = Schema.Struct({
  _tag: Schema.Literal('UpdateFeature'),
  featureId: Schema.String,
  title: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  content: Schema.optional(Schema.String),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
})

/**
 * Delete Feature Action
 */
export const DeleteFeatureAction = Schema.Struct({
  _tag: Schema.Literal('DeleteFeature'),
  featureId: Schema.String,
})

/**
 * Move Feature Action (change Kanban status)
 */
export const MoveFeatureAction = Schema.Struct({
  _tag: Schema.Literal('MoveFeature'),
  featureId: Schema.String,
  status: Schema.Union(
    Schema.Literal('TODO'),
    Schema.Literal('DOING'),
    Schema.Literal('REVIEWING'),
    Schema.Literal('DONE'),
  ),
})

/**
 * List Features Action
 */
export const ListFeaturesAction = Schema.Struct({
  _tag: Schema.Literal('ListFeatures'),
})

/**
 * Get Feature Action
 */
export const GetFeatureAction = Schema.Struct({
  _tag: Schema.Literal('GetFeature'),
  featureId: Schema.String,
})

/**
 * Union of all actions
 */
export const Action = Schema.Union(
  CreateFeatureAction,
  UpdateFeatureAction,
  DeleteFeatureAction,
  MoveFeatureAction,
  ListFeaturesAction,
  GetFeatureAction,
)

export type Action = typeof Action.Type

/**
 * Action result types
 */
export type ActionResult =
  | { _tag: 'FeatureCreated'; feature: typeof import('./feature').Feature.Type }
  | { _tag: 'FeatureUpdated'; feature: typeof import('./feature').Feature.Type }
  | { _tag: 'FeatureDeleted'; featureId: string }
  | { _tag: 'FeatureMoved'; feature: typeof import('./feature').Feature.Type }
  | { _tag: 'FeatureList'; features: Array<typeof import('./feature').Feature.Type> }
  | { _tag: 'Feature'; feature: typeof import('./feature').Feature.Type }

/**
 * Parse and decode an action from unknown input
 */
export const parseAction = (input: unknown) =>
  Schema.decodeUnknown(Action)(input).pipe(
    Effect.mapError(
      (error) =>
        new ActionParseError({
          message: 'Invalid action format',
          cause: error,
        }),
    ),
  )

/**
 * Handle an action and return a result
 */
export const handleAction = (action: Action) =>
  Effect.gen(function* () {
    const featureService = yield* FeatureService

    switch (action._tag) {
      case 'CreateFeature': {
        const data: CreateFeatureData = {
          projectPrefix: action.projectPrefix,
          title: action.title,
          description: action.description,
          acceptanceCriteria: action.acceptanceCriteria,
          tags: action.tags,
        }
        const feature = yield* featureService.createFeature(data)
        return { _tag: 'FeatureCreated' as const, feature }
      }

      case 'UpdateFeature': {
        const data: UpdateFeatureData = {
          title: action.title,
          tags: action.tags,
          content: action.content,
          assignee: action.assignee,
        }
        const feature = yield* featureService.updateFeature(
          action.featureId,
          data,
        )
        return { _tag: 'FeatureUpdated' as const, feature }
      }

      case 'DeleteFeature': {
        yield* featureService.deleteFeature(action.featureId)
        return { _tag: 'FeatureDeleted' as const, featureId: action.featureId }
      }

      case 'MoveFeature': {
        const feature = yield* featureService.moveFeature(
          action.featureId,
          action.status,
        )
        return { _tag: 'FeatureMoved' as const, feature }
      }

      case 'ListFeatures': {
        const features = yield* featureService.listFeatures()
        return { _tag: 'FeatureList' as const, features }
      }

      case 'GetFeature': {
        const feature = yield* featureService.getFeature(action.featureId)
        return { _tag: 'Feature' as const, feature }
      }
    }
  }).pipe(
    Effect.mapError(
      (error) =>
        new ActionHandlerError({
          action: (action as Action)._tag,
          message: 'message' in error ? (error as { message: string }).message : 'Action failed',
          cause: error,
        }),
    ),
  )
