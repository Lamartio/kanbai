<script setup lang="ts">
const { fetchFeatures } = useFeatures()

const isCreateModalOpen = ref(false)

const handleFeatureCreated = () => {
  fetchFeatures()
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
    <!-- Header -->
    <header
      class="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"
    >
      <div class="max-w-full mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center"
            >
              <span class="text-white font-bold text-sm">K</span>
            </div>
            <h1 class="text-xl font-bold text-gray-900 dark:text-white">
              Kanbai
            </h1>
            <UBadge color="neutral" variant="subtle" size="xs">
              AI Project Manager
            </UBadge>
          </div>

          <div class="flex items-center gap-2">
            <UButton
              icon="i-heroicons-plus"
              size="sm"
              @click="isCreateModalOpen = true"
            >
              New Feature
            </UButton>
            <UColorModeButton />
          </div>
        </div>
      </div>
    </header>

    <!-- Main content -->
    <main class="max-w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <KanbanBoard />
    </main>

    <!-- Create feature modal -->
    <CreateFeatureModal
      v-model:open="isCreateModalOpen"
      @created="handleFeatureCreated"
    />
  </div>
</template>
