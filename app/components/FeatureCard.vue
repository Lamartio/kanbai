<script setup lang="ts">
import type { Feature } from '~/server/services/feature'

const props = defineProps<{
  feature: Feature
}>()

const emit = defineEmits<{
  click: [feature: Feature]
  move: [featureId: string, status: 'TODO' | 'DOING' | 'REVIEWING' | 'DONE']
}>()

const nonStatusTags = computed(() =>
  props.feature.tags.filter(
    (t) => !['TODO', 'DOING', 'REVIEWING', 'DONE'].includes(t),
  ),
)

const handleClick = () => {
  emit('click', props.feature)
}
</script>

<template>
  <UCard
    class="feature-card cursor-pointer hover:ring-2 hover:ring-primary-500 transition-all"
    @click="handleClick"
  >
    <template #header>
      <div class="flex items-start justify-between gap-2">
        <div class="flex-1 min-w-0">
          <p class="text-xs text-gray-500 dark:text-gray-400 font-mono">
            {{ feature.id }}
          </p>
          <h4 class="font-medium text-sm truncate">
            {{ feature.title }}
          </h4>
        </div>
      </div>
    </template>

    <div class="flex flex-wrap gap-1">
      <UBadge
        v-for="tag in nonStatusTags"
        :key="tag"
        size="xs"
        color="neutral"
        variant="subtle"
      >
        {{ tag }}
      </UBadge>
    </div>

    <template #footer>
      <div class="flex items-center justify-between text-xs text-gray-500">
        <span v-if="feature.assignee">{{ feature.assignee }}</span>
        <span v-else class="italic">Unassigned</span>
      </div>
    </template>
  </UCard>
</template>
