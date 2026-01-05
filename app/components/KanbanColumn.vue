<script setup lang="ts">
import type { Feature } from '~/server/services/feature'

type KanbanStatus = 'TODO' | 'DOING' | 'REVIEWING' | 'DONE'

const props = defineProps<{
  title: string
  status: KanbanStatus
  features: Feature[]
}>()

const emit = defineEmits<{
  featureClick: [feature: Feature]
  featureMove: [featureId: string, status: KanbanStatus]
}>()

const columnColors: Record<KanbanStatus, string> = {
  TODO: 'bg-gray-100 dark:bg-gray-800',
  DOING: 'bg-blue-50 dark:bg-blue-900/20',
  REVIEWING: 'bg-yellow-50 dark:bg-yellow-900/20',
  DONE: 'bg-green-50 dark:bg-green-900/20',
}

const headerColors: Record<KanbanStatus, string> = {
  TODO: 'text-gray-700 dark:text-gray-300',
  DOING: 'text-blue-700 dark:text-blue-300',
  REVIEWING: 'text-yellow-700 dark:text-yellow-300',
  DONE: 'text-green-700 dark:text-green-300',
}

const handleFeatureClick = (feature: Feature) => {
  emit('featureClick', feature)
}

const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move'
  }
}

const handleDrop = (e: DragEvent) => {
  e.preventDefault()
  const featureId = e.dataTransfer?.getData('text/plain')
  if (featureId) {
    emit('featureMove', featureId, props.status)
  }
}

const handleDragStart = (e: DragEvent, feature: Feature) => {
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', feature.id)
    e.dataTransfer.effectAllowed = 'move'
  }
}
</script>

<template>
  <div
    :class="[
      'kanban-column rounded-lg p-3 flex flex-col',
      columnColors[status],
    ]"
    @dragover="handleDragOver"
    @drop="handleDrop"
  >
    <div class="flex items-center justify-between mb-3">
      <h3 :class="['font-semibold text-sm', headerColors[status]]">
        {{ title }}
      </h3>
      <UBadge size="xs" color="neutral" variant="subtle">
        {{ features.length }}
      </UBadge>
    </div>

    <div class="flex-1 space-y-2 overflow-y-auto">
      <div
        v-for="feature in features"
        :key="feature.id"
        draggable="true"
        @dragstart="handleDragStart($event, feature)"
      >
        <FeatureCard :feature="feature" @click="handleFeatureClick" />
      </div>

      <div
        v-if="features.length === 0"
        class="text-center text-gray-400 text-sm py-8"
      >
        No features
      </div>
    </div>
  </div>
</template>
