<script setup lang="ts">
import type { Feature } from '~/server/services/feature'

type KanbanStatus = 'TODO' | 'DOING' | 'REVIEWING' | 'DONE'

const { featuresByStatus, loading, error, fetchFeatures, moveFeature } =
  useFeatures()

const columns: { title: string; status: KanbanStatus }[] = [
  { title: 'To Do', status: 'TODO' },
  { title: 'In Progress', status: 'DOING' },
  { title: 'In Review', status: 'REVIEWING' },
  { title: 'Done', status: 'DONE' },
]

const selectedFeature = ref<Feature | null>(null)
const isDetailOpen = ref(false)

const handleFeatureClick = (feature: Feature) => {
  selectedFeature.value = feature
  isDetailOpen.value = true
}

const handleFeatureMove = async (featureId: string, status: KanbanStatus) => {
  await moveFeature(featureId, status)
}

const handleCloseDetail = () => {
  isDetailOpen.value = false
  selectedFeature.value = null
}

// Fetch features on mount
onMounted(() => {
  fetchFeatures()
})
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Error display -->
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      class="mb-4"
      :close-button="{ icon: 'i-heroicons-x-mark', color: 'error', variant: 'link' }"
      @close="error = null"
    >
      <template #title>Error</template>
      <template #description>{{ error }}</template>
    </UAlert>

    <!-- Loading state -->
    <div v-if="loading" class="flex items-center justify-center py-8">
      <UIcon name="i-heroicons-arrow-path" class="animate-spin w-6 h-6" />
      <span class="ml-2">Loading features...</span>
    </div>

    <!-- Kanban columns -->
    <div
      v-else
      class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 flex-1"
    >
      <KanbanColumn
        v-for="column in columns"
        :key="column.status"
        :title="column.title"
        :status="column.status"
        :features="featuresByStatus[column.status]"
        @feature-click="handleFeatureClick"
        @feature-move="handleFeatureMove"
      />
    </div>

    <!-- Feature detail slideover -->
    <USlideover v-model:open="isDetailOpen" side="right">
      <template #content>
        <div v-if="selectedFeature" class="p-6">
          <div class="flex items-start justify-between mb-4">
            <div>
              <p class="text-xs text-gray-500 font-mono mb-1">
                {{ selectedFeature.id }}
              </p>
              <h2 class="text-xl font-bold">{{ selectedFeature.title }}</h2>
            </div>
            <UButton
              icon="i-heroicons-x-mark"
              color="neutral"
              variant="ghost"
              @click="handleCloseDetail"
            />
          </div>

          <div class="flex flex-wrap gap-2 mb-6">
            <UBadge
              v-for="tag in selectedFeature.tags"
              :key="tag"
              :color="
                ['TODO', 'DOING', 'REVIEWING', 'DONE'].includes(tag)
                  ? 'primary'
                  : 'neutral'
              "
            >
              {{ tag }}
            </UBadge>
          </div>

          <div class="prose dark:prose-invert max-w-none">
            <div v-html="selectedFeature.content" />
          </div>

          <div class="mt-6 pt-6 border-t text-sm text-gray-500">
            <p>
              <strong>Created:</strong>
              {{ new Date(selectedFeature.created).toLocaleDateString() }}
            </p>
            <p>
              <strong>Updated:</strong>
              {{ new Date(selectedFeature.updated).toLocaleDateString() }}
            </p>
            <p>
              <strong>Assignee:</strong>
              {{ selectedFeature.assignee || 'Unassigned' }}
            </p>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>
