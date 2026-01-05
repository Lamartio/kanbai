import { Data } from 'effect'

// Storage errors
export class StorageError extends Data.TaggedError('StorageError')<{
  readonly operation: 'read' | 'write' | 'delete' | 'list'
  readonly path: string
  readonly cause?: unknown
}> {}

// Feature errors
export class FeatureNotFoundError extends Data.TaggedError('FeatureNotFoundError')<{
  readonly featureId: string
}> {}

export class FeatureValidationError extends Data.TaggedError('FeatureValidationError')<{
  readonly message: string
  readonly field?: string
}> {}

export class DuplicateFeatureError extends Data.TaggedError('DuplicateFeatureError')<{
  readonly featureId: string
}> {}

// Action errors
export class ActionParseError extends Data.TaggedError('ActionParseError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class ActionHandlerError extends Data.TaggedError('ActionHandlerError')<{
  readonly action: string
  readonly message: string
  readonly cause?: unknown
}> {}

// Union types for error handling
export type FeatureError =
  | FeatureNotFoundError
  | FeatureValidationError
  | DuplicateFeatureError
  | StorageError

export type ActionError =
  | ActionParseError
  | ActionHandlerError
  | FeatureError
