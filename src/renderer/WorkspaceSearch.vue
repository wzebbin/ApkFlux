<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { ElInput } from 'element-plus'
import type { FileSource, WorkspaceSearch, WorkspaceSearchHit } from '../shared/api'
import { usePreferences } from './preferences'

const props = defineProps<{ workspaceId: string; labels: Record<FileSource, string> }>()
const emit = defineEmits<{ open: [hit: WorkspaceSearchHit] }>()
const { text: t } = usePreferences()
const query = ref('')
const busy = ref(false)
const result = ref<WorkspaceSearch>()
const error = ref('')
let generation = 0

function reset() {
  generation++
  result.value = undefined
  busy.value = false
  error.value = ''
}
watch([query, () => props.workspaceId], reset, { flush: 'sync' })
onBeforeUnmount(reset)

async function search() {
  const term = query.value.trim()
  if (!term) return
  reset()
  const request = generation
  busy.value = true
  try {
    const reply = await window.apkflux.searchWorkspace(props.workspaceId, term)
    if (request !== generation) return
    if (reply.ok) result.value = reply.data
    else error.value = reply.error
  } catch (reason) {
    if (request === generation) error.value = String(reason)
  } finally { if (request === generation) busy.value = false }
}
</script>

<template>
  <div class="tree-search">
    <ElInput v-model="query" clearable :maxlength="200" :placeholder="t('搜索路径或内容，按 Enter', 'Search paths or contents, press Enter')"
      :aria-label="t('搜索整个 APK 工作区', 'Search the entire APK workspace')" @keydown.enter="search()" />
  </div>
  <div class="source-results">
    <p v-if="busy" class="side-empty" role="status">{{ t('正在搜索工作区…', 'Searching workspace…') }}</p>
    <p v-else-if="error" class="source-warning" role="alert">{{ error }}</p>
    <template v-else-if="result">
      <p v-if="result.missing.length" class="source-warning">
        {{ t('尚未生成，未参与搜索', 'Unavailable until generated') }} · {{ result.missing.map(source => labels[source]).join(' · ') }}
      </p>
      <p v-if="result.limited" class="source-warning">{{ t('已达到搜索限额，请缩小查询范围。', 'Search limit reached. Narrow the query.') }}</p>
      <p v-if="!result.hits.length" class="side-empty">{{ t('没有匹配的文件或内容。', 'No matching files or contents.') }}</p>
      <button v-for="hit in result.hits" :key="hit.source + ':' + hit.path + ':' + (hit.line ?? '')" type="button"
        :title="hit.path" @click="emit('open', hit)">
        <strong>{{ labels[hit.source] }} · {{ hit.path.split('/').at(-1) }}{{ hit.line ? ':' + hit.line : '' }}</strong>
        <small>{{ hit.path }}</small>
        <small v-if="hit.text">{{ hit.text }}</small>
      </button>
    </template>
  </div>
</template>
