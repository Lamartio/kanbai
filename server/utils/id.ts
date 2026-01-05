/**
 * Generate the next feature ID for a given prefix
 *
 * @param prefix - Project prefix (e.g., 'XYZ', 'XYZ-ABC')
 * @param existingIds - Array of existing feature IDs
 * @returns Next feature ID (e.g., 'XYZ-001', 'XYZ-002')
 */
export const generateFeatureId = (prefix: string, existingIds: string[]): string => {
  const relevantIds = existingIds.filter((id) => id.startsWith(prefix + '-'))

  const numbers = relevantIds.map((id) => {
    const parts = id.split('-')
    const lastPart = parts[parts.length - 1]
    return parseInt(lastPart, 10)
  }).filter((n) => !isNaN(n))

  const nextNumber = Math.max(0, ...numbers) + 1
  return `${prefix}-${String(nextNumber).padStart(3, '0')}`
}

/**
 * Extract the numeric part from a feature ID
 *
 * @param featureId - Feature ID (e.g., 'XYZ-001')
 * @returns The numeric part (e.g., 1)
 */
export const extractFeatureNumber = (featureId: string): number => {
  const parts = featureId.split('-')
  const lastPart = parts[parts.length - 1]
  return parseInt(lastPart, 10)
}

/**
 * Extract the prefix from a feature ID
 *
 * @param featureId - Feature ID (e.g., 'XYZ-ABC-001')
 * @returns The prefix (e.g., 'XYZ-ABC')
 */
export const extractPrefix = (featureId: string): string => {
  const parts = featureId.split('-')
  return parts.slice(0, -1).join('-')
}

/**
 * Generate a filename from a feature ID and title
 *
 * @param id - Feature ID (e.g., 'XYZ-001')
 * @param title - Feature title
 * @returns Filename (e.g., 'XYZ-001-user-authentication.md')
 */
export const generateFilename = (id: string, title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)

  return `${id}-${slug}.md`
}
