import type { Feature } from '~/server/services/feature'

interface ActionResponse<T> {
  success: boolean
  data?: T
  error?: { type?: string; message: string }
}

interface CreateFeatureParams {
  projectPrefix: string
  title: string
  description: string
  acceptanceCriteria?: string[]
  tags?: string[]
}

interface UpdateFeatureParams {
  title?: string
  tags?: string[]
  content?: string
  assignee?: string | null
}

type KanbanStatus = 'TODO' | 'DOING' | 'REVIEWING' | 'DONE'

export const useFeatures = () => {
  const features = ref<Feature[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Fetch all features
   */
  const fetchFeatures = async () => {
    loading.value = true
    error.value = null

    try {
      const response = await $fetch<ActionResponse<Feature[]>>(
        '/api/features',
      )
      if (response.success && response.data) {
        features.value = response.data
      } else {
        error.value = response.error?.message || 'Failed to fetch features'
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch features'
    } finally {
      loading.value = false
    }
  }

  /**
   * Get a single feature by ID
   */
  const getFeature = async (id: string) => {
    loading.value = true
    error.value = null

    try {
      const response = await $fetch<ActionResponse<Feature>>(
        `/api/features/${id}`,
      )
      if (response.success && response.data) {
        return response.data
      }
      error.value = response.error?.message || 'Feature not found'
      return null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch feature'
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * Create a new feature
   */
  const createFeature = async (params: CreateFeatureParams) => {
    loading.value = true
    error.value = null

    try {
      const response = await $fetch<
        ActionResponse<{ feature: Feature }>
      >('/api/actions', {
        method: 'POST',
        body: {
          _tag: 'CreateFeature',
          ...params,
        },
      })

      if (response.success && response.data) {
        features.value.push(response.data.feature)
        return response.data.feature
      }
      error.value = response.error?.message || 'Failed to create feature'
      return null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create feature'
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * Update a feature
   */
  const updateFeature = async (id: string, params: UpdateFeatureParams) => {
    loading.value = true
    error.value = null

    try {
      const response = await $fetch<
        ActionResponse<{ feature: Feature }>
      >('/api/actions', {
        method: 'POST',
        body: {
          _tag: 'UpdateFeature',
          featureId: id,
          ...params,
        },
      })

      if (response.success && response.data) {
        const index = features.value.findIndex((f) => f.id === id)
        if (index !== -1) {
          features.value[index] = response.data.feature
        }
        return response.data.feature
      }
      error.value = response.error?.message || 'Failed to update feature'
      return null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to update feature'
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * Delete a feature
   */
  const deleteFeature = async (id: string) => {
    loading.value = true
    error.value = null

    try {
      const response = await $fetch<ActionResponse<{ featureId: string }>>(
        '/api/actions',
        {
          method: 'POST',
          body: {
            _tag: 'DeleteFeature',
            featureId: id,
          },
        },
      )

      if (response.success) {
        features.value = features.value.filter((f) => f.id !== id)
        return true
      }
      error.value = response.error?.message || 'Failed to delete feature'
      return false
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to delete feature'
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * Move a feature to a new status
   */
  const moveFeature = async (id: string, status: KanbanStatus) => {
    loading.value = true
    error.value = null

    try {
      const response = await $fetch<
        ActionResponse<{ feature: Feature }>
      >('/api/actions', {
        method: 'POST',
        body: {
          _tag: 'MoveFeature',
          featureId: id,
          status,
        },
      })

      if (response.success && response.data) {
        const index = features.value.findIndex((f) => f.id === id)
        if (index !== -1) {
          features.value[index] = response.data.feature
        }
        return response.data.feature
      }
      error.value = response.error?.message || 'Failed to move feature'
      return null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to move feature'
      return null
    } finally {
      loading.value = false
    }
  }

  /**
   * Get features grouped by Kanban status
   */
  const featuresByStatus = computed(() => {
    const grouped: Record<KanbanStatus, Feature[]> = {
      TODO: [],
      DOING: [],
      REVIEWING: [],
      DONE: [],
    }

    for (const feature of features.value) {
      const status = feature.tags.find((t) =>
        ['TODO', 'DOING', 'REVIEWING', 'DONE'].includes(t),
      ) as KanbanStatus | undefined

      if (status) {
        grouped[status].push(feature)
      } else {
        grouped.TODO.push(feature)
      }
    }

    return grouped
  })

  return {
    features,
    featuresByStatus,
    loading,
    error,
    fetchFeatures,
    getFeature,
    createFeature,
    updateFeature,
    deleteFeature,
    moveFeature,
  }
}
