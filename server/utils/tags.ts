/**
 * Default Kanban column tags
 */
export const KANBAN_TAGS = ['TODO', 'DOING', 'REVIEWING', 'DONE'] as const
export type KanbanTag = (typeof KANBAN_TAGS)[number]

/**
 * Check if a string is a valid tag (URL-safe characters only)
 *
 * @param tag - Tag to validate
 * @returns true if valid
 */
export const isValidTag = (tag: string): boolean => /^[a-zA-Z0-9_-]+$/.test(tag)

/**
 * Sanitize a tag to only contain URL-safe characters
 *
 * @param tag - Tag to sanitize
 * @returns Sanitized tag
 */
export const sanitizeTag = (tag: string): string =>
  tag.replace(/[^a-zA-Z0-9_-]/g, '')

/**
 * Filter and sanitize an array of tags
 *
 * @param tags - Tags to process
 * @returns Array of valid, sanitized tags
 */
export const processTags = (tags: string[]): string[] =>
  tags
    .map(sanitizeTag)
    .filter((tag) => tag.length > 0)

/**
 * Ensure at least one Kanban tag is present
 *
 * @param tags - Current tags
 * @param defaultTag - Default Kanban tag to add if none present
 * @returns Tags with at least one Kanban tag
 */
export const ensureKanbanTag = (
  tags: string[],
  defaultTag: KanbanTag = 'TODO',
): string[] => {
  const hasKanbanTag = tags.some((tag) =>
    KANBAN_TAGS.includes(tag as KanbanTag),
  )

  if (hasKanbanTag) {
    return tags
  }

  return [defaultTag, ...tags]
}

/**
 * Get the current Kanban status from tags
 *
 * @param tags - Feature tags
 * @returns The Kanban tag or undefined
 */
export const getKanbanStatus = (tags: string[]): KanbanTag | undefined =>
  tags.find((tag) => KANBAN_TAGS.includes(tag as KanbanTag)) as
    | KanbanTag
    | undefined

/**
 * Update Kanban status by replacing the old status tag
 *
 * @param tags - Current tags
 * @param newStatus - New Kanban status
 * @returns Updated tags array
 */
export const updateKanbanStatus = (
  tags: string[],
  newStatus: KanbanTag,
): string[] => {
  const filteredTags = tags.filter(
    (tag) => !KANBAN_TAGS.includes(tag as KanbanTag),
  )
  return [newStatus, ...filteredTags]
}
