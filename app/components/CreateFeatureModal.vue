<script setup lang="ts">
const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  created: []
}>()

const { createFeature, loading, error } = useFeatures()

const form = reactive({
  projectPrefix: 'KANBAI',
  title: '',
  description: '',
  acceptanceCriteria: '',
  tags: '',
})

const resetForm = () => {
  form.title = ''
  form.description = ''
  form.acceptanceCriteria = ''
  form.tags = ''
}

const handleSubmit = async () => {
  const acceptanceCriteria = form.acceptanceCriteria
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const tags = form.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)

  const result = await createFeature({
    projectPrefix: form.projectPrefix,
    title: form.title,
    description: form.description,
    acceptanceCriteria:
      acceptanceCriteria.length > 0 ? acceptanceCriteria : undefined,
    tags: tags.length > 0 ? tags : undefined,
  })

  if (result) {
    resetForm()
    emit('update:open', false)
    emit('created')
  }
}

const handleClose = () => {
  emit('update:open', false)
}
</script>

<template>
  <UModal :open="open" @update:open="emit('update:open', $event)">
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">Create Feature</h3>
            <UButton
              icon="i-heroicons-x-mark"
              color="neutral"
              variant="ghost"
              @click="handleClose"
            />
          </div>
        </template>

        <form class="space-y-4" @submit.prevent="handleSubmit">
          <UAlert v-if="error" color="error" variant="subtle">
            <template #description>{{ error }}</template>
          </UAlert>

          <UFormField label="Project Prefix" required>
            <UInput
              v-model="form.projectPrefix"
              placeholder="e.g., KANBAI, PROJ-SUB"
            />
          </UFormField>

          <UFormField label="Title" required>
            <UInput v-model="form.title" placeholder="Feature title" />
          </UFormField>

          <UFormField label="Description" required>
            <UTextarea
              v-model="form.description"
              :rows="4"
              placeholder="Describe the feature..."
            />
          </UFormField>

          <UFormField label="Acceptance Criteria">
            <UTextarea
              v-model="form.acceptanceCriteria"
              :rows="3"
              placeholder="One criterion per line..."
            />
            <template #hint>Enter each criterion on a new line</template>
          </UFormField>

          <UFormField label="Tags">
            <UInput
              v-model="form.tags"
              placeholder="tag1, tag2, tag3"
            />
            <template #hint>Comma-separated, URL-safe characters only</template>
          </UFormField>
        </form>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="outline" @click="handleClose">
              Cancel
            </UButton>
            <UButton
              :loading="loading"
              :disabled="!form.title || !form.description"
              @click="handleSubmit"
            >
              Create Feature
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
